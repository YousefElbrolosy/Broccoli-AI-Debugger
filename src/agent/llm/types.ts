/**
 * Provider-neutral LLM client abstraction.
 *
 * Caching strategy (kept equivalent across providers by *structure*):
 *  - Anthropic: explicit cache_control: ephemeral on system + tools (handled in client).
 *  - OpenAI / Groq / DeepSeek / Together: automatic prompt caching for prefixes ≥1024 tokens.
 *  - Ollama: server-side KV cache hits while the prefix is stable.
 *
 * The agent only appends to `messages`; system prompt and tool defs stay byte-identical
 * across turns. That alone gives near-optimal cache hits on every supported provider.
 */

export type ToolSchema = {
    name: string;
    description: string;
    /** JSON Schema for the tool input. */
    input_schema: object;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    /** Parsed input object. */
    input: any;
};

export type NormalizedMessage =
    | { role: 'user'; content: string }
    | {
          role: 'assistant';
          /** Free-text content the model produced before / between tool calls. */
          text?: string;
          toolCalls: NormalizedToolCall[];
      }
    | {
          role: 'tool';
          toolCallId: string;
          content: string;
          isError: boolean;
      };

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'other';

export interface LLMResponse {
    text?: string;
    toolCalls: NormalizedToolCall[];
    stopReason: StopReason;
}

export interface LLMClient {
    /** Human-readable identifier, e.g. "anthropic/claude-haiku-4-5". */
    readonly label: string;

    step(args: {
        system: string;
        tools: ToolSchema[];
        messages: NormalizedMessage[];
        signal: AbortSignal;
        maxTokens?: number;
    }): Promise<LLMResponse>;
}

export type ProviderId = 'anthropic' | 'openai-compat';

export interface ProviderConfig {
    provider: ProviderId;
    /** Model id understood by the provider. */
    model: string;
    apiKey: string;
    /** Required for openai-compat when not pointing at api.openai.com. */
    baseURL?: string;
    /** Cosmetic label shown in logs/UI; auto-derived if absent. */
    displayName?: string;
}
