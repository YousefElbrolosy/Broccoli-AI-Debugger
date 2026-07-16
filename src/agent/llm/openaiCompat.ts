import OpenAI from 'openai';
import type {
    LLMClient,
    LLMResponse,
    NormalizedMessage,
    NormalizedToolCall,
    StopReason,
    ToolSchema
} from './types';

/**
 * Works with any /v1/chat/completions endpoint that supports tool_calls:
 * OpenAI, Groq, DeepSeek, Together, xAI, Ollama (newer models), etc.
 *
 * Caching: these providers cache automatically when the prompt prefix
 * (system + tools) exceeds ~1024 tokens and is byte-stable across requests.
 * We don't need an explicit flag.
 */
export class OpenAICompatClient implements LLMClient {
    readonly label: string;
    private readonly client: OpenAI;

    constructor(
        private readonly cfg: {
            apiKey: string;
            model: string;
            baseURL?: string;
            displayName?: string;
        }
    ) {
        this.client = new OpenAI({
            apiKey: cfg.apiKey || 'no-key', // Ollama allows an empty key
            baseURL: cfg.baseURL
        });
        this.label = cfg.displayName
            ? `${cfg.displayName}/${cfg.model}`
            : `openai-compat/${cfg.model}`;
    }

    async step(args: {
        system: string;
        tools: ToolSchema[];
        messages: NormalizedMessage[];
        signal: AbortSignal;
        maxTokens?: number;
    }): Promise<LLMResponse> {
        const tools = args.tools.map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: sanitizeSchema(t.input_schema) as Record<string, unknown>
            }
        }));

        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: args.system },
            ...toOpenAIMessages(args.messages)
        ];

        const resp = await this.callWithRetry(
            {
                model: this.cfg.model,
                max_tokens: args.maxTokens ?? 4096,
                temperature: 0.2,
                messages,
                tools,
                tool_choice: 'auto'
            },
            args.signal
        );

        const choice = resp.choices[0];
        const msg = choice.message;
        const text = msg.content ?? undefined;
        const knownNames = new Set(args.tools.map(t => t.name));
        const toolCalls: NormalizedToolCall[] = [];
        for (const tc of msg.tool_calls ?? []) {
            if (tc.type !== 'function') { continue; }
            const { name, input } = sanitizeCall(
                tc.function.name,
                tc.function.arguments,
                knownNames
            );
            toolCalls.push({ id: tc.id, name, input });
        }

        const finish = choice.finish_reason;
        const stopReason: StopReason =
            finish === 'tool_calls'
                ? 'tool_use'
                : finish === 'stop'
                ? 'end_turn'
                : finish === 'length'
                ? 'max_tokens'
                : 'other';

        const usage = resp.usage
            ? {
                  inputTokens: resp.usage.prompt_tokens ?? 0,
                  outputTokens: resp.usage.completion_tokens ?? 0,
                  cacheReadTokens: resp.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  cacheWriteTokens: 0
              }
            : undefined;

        return { text, toolCalls, stopReason, usage };
    }

    /**
     * Retry on transient failures:
     *  - 400 "Failed to call a function" — sampling-time tool-call validation
     *    failures from providers like Groq; usually transient. Re-extract
     *    `failed_generation` for diagnostics.
     *  - 429 / 5xx / connection errors — rate limits and overloads, retried
     *    with exponential backoff.
     */
    private async callWithRetry(
        params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        signal: AbortSignal
    ): Promise<OpenAI.Chat.ChatCompletion> {
        const maxAttempts = 3;
        let lastErr: unknown;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                return await this.client.chat.completions.create(params, { signal });
            } catch (e: any) {
                lastErr = e;
                if (signal.aborted) { throw e; }
                const status: number | undefined = e?.status;
                const transient =
                    status === 429 ||
                    (status !== undefined && status >= 500) ||
                    e instanceof OpenAI.APIConnectionError;
                if (status === 400) {
                    const failed =
                        e?.error?.failed_generation ??
                        e?.response?.data?.error?.failed_generation;
                    if (failed) {
                        // Surface the bad output so the user can see why validation failed.
                        console.error('[broccoli] failed_generation:', failed);
                    }
                } else if (!transient) {
                    throw e;
                }
                if (i === maxAttempts - 1) { break; }
                const backoff = status === 400 ? 400 * (i + 1) : 1000 * 2 ** i + Math.random() * 500;
                await new Promise(r => setTimeout(r, backoff));
            }
        }
        throw lastErr;
    }
}

/**
 * Some providers (notably Groq) reject JSON-Schema keywords like `default`
 * with a 400 "Failed to call a function". Strip them client-side.
 */
function sanitizeSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') { return schema; }
    if (Array.isArray(schema)) { return schema.map(sanitizeSchema); }
    const STRIP = new Set(['default', 'examples', '$schema', '$id']);
    const out: any = {};
    for (const [k, v] of Object.entries(schema)) {
        if (STRIP.has(k)) { continue; }
        out[k] = sanitizeSchema(v);
    }
    return out;
}

/**
 * Some weaker open-weight models (e.g. Llama-3.3 on Groq) occasionally emit
 *   function.name = "continue_execution({\"timeout_ms\":15000})"
 * with empty arguments. The provider then 400s when we replay that assistant
 * turn. Recover by extracting the real name and parsing args from the parens.
 * If the result is still not in the known tool set, prefix with "INVALID__"
 * so the local dispatcher returns a clean error instead of the API rejecting.
 * Exported for unit tests.
 */
export function sanitizeCall(
    rawName: string,
    rawArgs: string | undefined,
    known: Set<string>
): { name: string; input: any } {
    let name = rawName ?? '';
    let argText = rawArgs ?? '';

    const parenIdx = name.indexOf('(');
    if (parenIdx >= 0) {
        const closeIdx = name.lastIndexOf(')');
        const inside = closeIdx > parenIdx ? name.slice(parenIdx + 1, closeIdx) : '';
        if (inside && !argText) {
            argText = inside;
        }
        name = name.slice(0, parenIdx).trim();
    }

    let input: any = {};
    if (argText) {
        try {
            input = JSON.parse(argText);
        } catch {
            input = { _raw: argText };
        }
    }

    if (!known.has(name)) {
        // Prefix so dispatcher's "Unknown tool" path runs and the assistant
        // turn we replay carries a name the provider will accept (no parens).
        name = `INVALID__${name || 'empty'}`;
    }
    return { name, input };
}

function toOpenAIMessages(
    msgs: NormalizedMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    for (const m of msgs) {
        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
            out.push({
                role: 'assistant',
                content: m.text ?? null,
                tool_calls: m.toolCalls.length
                    ? m.toolCalls.map(tc => ({
                          id: tc.id,
                          type: 'function' as const,
                          function: {
                              name: tc.name,
                              arguments: JSON.stringify(tc.input ?? {})
                          }
                      }))
                    : undefined
            });
        } else {
            out.push({
                role: 'tool',
                tool_call_id: m.toolCallId,
                content: m.content
            });
        }
    }
    return out;
}
