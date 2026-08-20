import { AnthropicClient } from './anthropic';
import { OpenAICompatClient } from './openaiCompat';
import type { LLMClient, ProviderConfig, ProviderId } from './types';

export * from './types';

export function createClient(cfg: ProviderConfig): LLMClient {
    switch (cfg.provider) {
        case 'anthropic':
            return new AnthropicClient({ apiKey: cfg.apiKey, model: cfg.model });
        case 'openai-compat':
            return new OpenAICompatClient({
                apiKey: cfg.apiKey,
                model: cfg.model,
                baseURL: cfg.baseURL,
                displayName: cfg.displayName
            });
        default: {
            const _exhaustive: never = cfg.provider;
            throw new Error(`Unknown provider: ${_exhaustive}`);
        }
    }
}

/** Built-in OpenAI-compatible endpoints. */
export const OPENAI_COMPAT_PRESETS = {
    openai: {
        displayName: 'openai',
        baseURL: undefined, // SDK default
        defaultModel: 'gpt-4o-mini',
        keyHint: 'sk-proj-... or sk-...'
    },
    groq: {
        displayName: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        keyHint: 'gsk_...'
    },
    deepseek: {
        displayName: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        keyHint: 'sk-...'
    },
    together: {
        displayName: 'together',
        baseURL: 'https://api.together.xyz/v1',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        keyHint: 'tok-...'
    },
    xai: {
        displayName: 'xai',
        baseURL: 'https://api.x.ai/v1',
        defaultModel: 'grok-2-latest',
        keyHint: 'xai-...'
    },
    ollama: {
        displayName: 'ollama',
        baseURL: 'http://localhost:11434/v1',
        defaultModel: 'llama3.1',
        keyHint: '(none — leave blank)'
    },
    custom: {
        displayName: 'custom',
        baseURL: undefined,
        defaultModel: '',
        keyHint: 'your provider key'
    }
} as const;

export type CompatPreset = keyof typeof OPENAI_COMPAT_PRESETS;

export const ANTHROPIC_PRESET = {
    displayName: 'anthropic',
    defaultModel: 'claude-haiku-4-5',
    keyHint: 'sk-ant-...'
};

export function detectProviderFromKey(key: string): ProviderId | undefined {
    if (key.startsWith('sk-ant-')) { return 'anthropic'; }
    if (
        key.startsWith('sk-') ||
        key.startsWith('gsk_') ||
        key.startsWith('xai-') ||
        key.startsWith('tok-')
    ) {
        return 'openai-compat';
    }
    return undefined;
}
