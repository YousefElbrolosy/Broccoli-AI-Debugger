import Anthropic from '@anthropic-ai/sdk';
import type {
    LLMClient,
    LLMResponse,
    NormalizedMessage,
    NormalizedToolCall,
    StopReason,
    ToolSchema
} from './types';

/**
 * Anthropic implementation. Uses native tool_use / tool_result content blocks
 * and tags system + tools with cache_control: ephemeral so the prefix is cached.
 */
export class AnthropicClient implements LLMClient {
    readonly label: string;
    private readonly client: Anthropic;

    constructor(private readonly cfg: { apiKey: string; model: string }) {
        this.client = new Anthropic({ apiKey: cfg.apiKey });
        this.label = `anthropic/${cfg.model}`;
    }

    async step(args: {
        system: string;
        tools: ToolSchema[];
        messages: NormalizedMessage[];
        signal: AbortSignal;
        maxTokens?: number;
    }): Promise<LLMResponse> {
        const tools: Anthropic.Tool[] = args.tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool.InputSchema,
            // Mark only the last tool so the entire tools array is part of the cached prefix.
            ...(i === args.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
        }));

        const messages: Anthropic.MessageParam[] = toAnthropicMessages(args.messages);

        const resp = await this.client.messages.create(
            {
                model: this.cfg.model,
                max_tokens: args.maxTokens ?? 4096,
                system: [
                    {
                        type: 'text',
                        text: args.system,
                        cache_control: { type: 'ephemeral' }
                    }
                ],
                tools,
                messages
            },
            { signal: args.signal }
        );

        let text: string | undefined;
        const toolCalls: NormalizedToolCall[] = [];
        for (const block of resp.content) {
            if (block.type === 'text') {
                text = (text ? `${text}\n` : '') + block.text;
            } else if (block.type === 'tool_use') {
                toolCalls.push({ id: block.id, name: block.name, input: block.input });
            }
        }

        const stopReason: StopReason =
            resp.stop_reason === 'tool_use'
                ? 'tool_use'
                : resp.stop_reason === 'end_turn'
                ? 'end_turn'
                : resp.stop_reason === 'max_tokens'
                ? 'max_tokens'
                : 'other';

        return { text, toolCalls, stopReason };
    }
}

function toAnthropicMessages(msgs: NormalizedMessage[]): Anthropic.MessageParam[] {
    // Group consecutive tool messages into a single user turn with tool_result blocks
    // (Anthropic requires tool_result blocks under role: 'user').
    const out: Anthropic.MessageParam[] = [];
    let i = 0;
    while (i < msgs.length) {
        const m = msgs[i];
        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
            i++;
        } else if (m.role === 'assistant') {
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.text && m.text.trim()) {
                blocks.push({ type: 'text', text: m.text });
            }
            for (const tc of m.toolCalls) {
                blocks.push({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.input
                });
            }
            out.push({ role: 'assistant', content: blocks });
            i++;
        } else {
            // Coalesce consecutive tool messages.
            const toolBlocks: Anthropic.ToolResultBlockParam[] = [];
            while (i < msgs.length && msgs[i].role === 'tool') {
                const t = msgs[i] as Extract<NormalizedMessage, { role: 'tool' }>;
                toolBlocks.push({
                    type: 'tool_result',
                    tool_use_id: t.toolCallId,
                    content: t.content,
                    is_error: t.isError
                });
                i++;
            }
            out.push({ role: 'user', content: toolBlocks });
        }
    }
    return out;
}
