import * as vscode from 'vscode';
import {
    ANTHROPIC_PRESET,
    OPENAI_COMPAT_PRESETS,
    type CompatPreset,
    type ProviderConfig,
    detectProviderFromKey
} from './llm';

const SECRET_KEY = 'broccoli.providerConfig';

export async function getProviderConfig(
    context: vscode.ExtensionContext
): Promise<ProviderConfig | undefined> {
    const raw = await context.secrets.get(SECRET_KEY);
    if (!raw) { return undefined; }
    try {
        return JSON.parse(raw) as ProviderConfig;
    } catch {
        return undefined;
    }
}

export async function clearProviderConfig(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Broccoli: provider config cleared.');
}

/**
 * Multi-step wizard:
 *   1. Pick provider preset.
 *   2. Pick / enter model id (with the preset default pre-filled).
 *   3. Enter base URL (only for "custom").
 *   4. Enter API key (skipped for ollama).
 */
export async function configureProvider(
    context: vscode.ExtensionContext
): Promise<ProviderConfig | undefined> {
    type PresetKey = 'anthropic' | CompatPreset;

    const choices: Array<{ label: string; description: string; key: PresetKey }> = [
        { label: 'Anthropic', description: 'Claude (sk-ant-...)', key: 'anthropic' },
        { label: 'OpenAI', description: 'gpt-4o, gpt-4o-mini, ...', key: 'openai' },
        { label: 'Groq', description: 'Llama, Mixtral, fast inference', key: 'groq' },
        { label: 'DeepSeek', description: 'deepseek-chat, deepseek-coder', key: 'deepseek' },
        { label: 'Together', description: 'Hosted open-weight models', key: 'together' },
        { label: 'xAI', description: 'Grok models', key: 'xai' },
        { label: 'Ollama (local)', description: 'http://localhost:11434', key: 'ollama' },
        { label: 'Custom OpenAI-compatible', description: 'Any /v1/chat/completions endpoint', key: 'custom' }
    ];

    const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Choose your LLM provider',
        ignoreFocusOut: true
    });
    if (!picked) { return undefined; }

    const presetKey = picked.key;
    const isAnthropic = presetKey === 'anthropic';
    const preset = isAnthropic ? ANTHROPIC_PRESET : OPENAI_COMPAT_PRESETS[presetKey];

    const model = await vscode.window.showInputBox({
        prompt: `Model id for ${picked.label}`,
        value: preset.defaultModel,
        ignoreFocusOut: true,
        validateInput: v => (v.trim() ? null : 'Model id is required')
    });
    if (!model) { return undefined; }

    let baseURL: string | undefined;
    if (!isAnthropic) {
        const compatPreset = preset as (typeof OPENAI_COMPAT_PRESETS)[CompatPreset];
        if (presetKey === 'custom') {
            baseURL = await vscode.window.showInputBox({
                prompt: 'Base URL for the OpenAI-compatible endpoint',
                placeHolder: 'https://example.com/v1',
                ignoreFocusOut: true,
                validateInput: v => (/^https?:\/\//.test(v) ? null : 'Must start with http(s)://')
            });
            if (!baseURL) { return undefined; }
        } else {
            baseURL = compatPreset.baseURL;
        }
    }

    const isOllama = presetKey === 'ollama';
    const apiKey = await vscode.window.showInputBox({
        prompt: `API key for ${picked.label}`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: preset.keyHint,
        validateInput: v => {
            if (isOllama) { return null; } // optional
            if (!v) { return 'API key is required'; }
            if (isAnthropic && !v.startsWith('sk-ant-')) {
                return 'Expected an sk-ant- key';
            }
            return null;
        }
    });
    if (apiKey === undefined) { return undefined; } // explicit cancel

    const config: ProviderConfig = {
        provider: isAnthropic ? 'anthropic' : 'openai-compat',
        model: model.trim(),
        apiKey: apiKey.trim(),
        baseURL,
        displayName: isAnthropic ? 'anthropic' : (preset as any).displayName
    };

    // Sanity: for openai-compat with no preset URL and no custom URL → reject.
    if (config.provider === 'openai-compat' && !config.baseURL && presetKey !== 'openai') {
        vscode.window.showErrorMessage('Base URL missing for selected provider.');
        return undefined;
    }

    await context.secrets.store(SECRET_KEY, JSON.stringify(config));
    vscode.window.showInformationMessage(
        `Broccoli: ${picked.label} configured (${config.model}).`
    );
    return config;
}

/**
 * Convenience: if the user only has a key string and not a full config,
 * try to auto-detect provider. Used when migrating from an older install.
 */
export function inferConfigFromKey(key: string): ProviderConfig | undefined {
    const provider = detectProviderFromKey(key);
    if (!provider) { return undefined; }
    if (provider === 'anthropic') {
        return {
            provider,
            apiKey: key,
            model: ANTHROPIC_PRESET.defaultModel,
            displayName: 'anthropic'
        };
    }
    // openai-compat without a baseURL defaults to api.openai.com (sk- keys).
    return {
        provider,
        apiKey: key,
        model: OPENAI_COMPAT_PRESETS.openai.defaultModel,
        displayName: 'openai'
    };
}
