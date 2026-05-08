import * as vscode from 'vscode';
import { DebugTools } from './DebugTools';
import { TOOLS } from './schemas';
import { SYSTEM_PROMPT } from './systemPrompt';
import type { DebugSessionController } from '../session/DebugSessionController';
import { createClient } from './llm';
import type { LLMClient, NormalizedMessage, NormalizedToolCall, ProviderConfig } from './llm';
import type { AgentState } from './AgentState';

const DEFAULT_MAX_TURNS = 25;
const MAX_TOOL_RESULT_CHARS = 8000;

export interface AgentRunOptions {
    config: ProviderConfig;
    controller: DebugSessionController;
    initialUserMessage: string;
    output: vscode.OutputChannel;
    cancel: vscode.CancellationToken;
    maxTurns?: number;
    state?: AgentState;
}

export async function runAgent(opts: AgentRunOptions): Promise<{
    finished: boolean;
    summary?: string;
    turns: number;
}> {
    const { config, controller, initialUserMessage, output, cancel, state } = opts;
    const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

    const client: LLMClient = createClient(config);
    const tools = new DebugTools(controller);

    log(output, `Using ${client.label}`);

    const messages: NormalizedMessage[] = [
        { role: 'user', content: initialUserMessage }
    ];

    let turns = 0;
    let summary: string | undefined;
    let finished = false;
    let nudgesUsed = 0;
    const MAX_NUDGES = 2;

    while (turns < maxTurns) {
        if (cancel.isCancellationRequested) {
            log(output, 'Cancelled by user.');
            break;
        }
        turns++;
        log(output, `--- Turn ${turns}/${maxTurns} ---`);
        state?.set({ kind: 'running', turn: turns, maxTurns });

        let resp;
        try {
            resp = await client.step({
                system: SYSTEM_PROMPT,
                tools: TOOLS,
                messages,
                signal: abortSignalFrom(cancel)
            });
        } catch (e) {
            if (cancel.isCancellationRequested) { break; }
            log(output, `API error: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }

        if (resp.text && resp.text.trim()) {
            log(output, `Assistant: ${resp.text}`);
            state?.append({ kind: 'thought', text: resp.text.trim(), turn: turns });
        }

        // Recovery: weaker models occasionally emit a tool payload as plain
        // assistant text instead of using the function-calling channel. If we
        // can recognize the JSON, synthesize a tool call so the side effects
        // (e.g. propose_code_fix's diff dialog) actually run.
        let toolCalls = resp.toolCalls;
        let recovered = false;
        if (toolCalls.length === 0 && resp.text) {
            const synth = recoverToolCallFromText(resp.text);
            if (synth) {
                log(output, `Recovered tool call from text: ${synth.name}`);
                toolCalls = [synth];
                recovered = true;
            }
        }

        messages.push({
            role: 'assistant',
            text: recovered ? undefined : resp.text,
            toolCalls
        });

        if (toolCalls.length === 0) {
            // Detect models that describe a fix in prose/markdown instead of
            // calling propose_code_fix. Nudge them to use the tool.
            if (
                resp.text &&
                looksLikeFixIntent(resp.text) &&
                nudgesUsed < MAX_NUDGES
            ) {
                nudgesUsed++;
                log(
                    output,
                    `Detected fix described as text — nudging model to use propose_code_fix (${nudgesUsed}/${MAX_NUDGES}).`
                );
                messages.push({
                    role: 'user',
                    content:
                        'Your previous message described a code change in text or unified-diff form. That output is ignored — only structured tool calls execute. Invoke propose_code_fix now with arguments {file, changes:[{start_line, start_char, end_line, end_char, new_text}], rationale}. Lines are 1-indexed (matching read_source numbering); columns are 0-indexed. After the user accepts or rejects, call finish.'
                });
                continue;
            }
            log(output, `Stop reason: ${resp.stopReason}`);
            break;
        }

        for (const call of toolCalls) {
            state?.set({ kind: 'running', turn: turns, maxTurns, toolName: call.name });
            log(output, `→ tool_use ${call.name} ${JSON.stringify(call.input)}`);
            if (call.name === 'propose_code_fix' && typeof call.input?.rationale === 'string') {
                state?.append({
                    kind: 'rationale',
                    text: call.input.rationale,
                    turn: turns
                });
            }
            const result = await tools.dispatch(call.name, call.input);
            const truncated = truncate(result.content, MAX_TOOL_RESULT_CHARS);
            log(
                output,
                `← ${call.name} ${result.isError ? '[error]' : '[ok]'}: ${truncated.slice(0, 400)}`
            );
            messages.push({
                role: 'tool',
                toolCallId: call.id,
                content: truncated,
                isError: result.isError === true
            });
            if (result.terminal) {
                summary = result.terminal.summary;
                finished = true;
                if (summary) {
                    state?.append({ kind: 'summary', text: summary, turn: turns });
                }
            }
        }

        if (finished) {
            log(output, `Agent called finish: ${summary ?? '(no summary)'}`);
            break;
        }
    }

    if (turns >= maxTurns && !finished) {
        log(output, `Reached MAX_TURNS=${maxTurns} without finish.`);
    }
    return { finished, summary, turns };
}

/**
 * Try to recover a tool call from plain assistant text. Detects the two payload
 * shapes the model is most likely to dump verbatim: propose_code_fix and finish.
 */
function recoverToolCallFromText(text: string): NormalizedToolCall | undefined {
    const obj = extractFirstJsonObject(text);
    if (!obj || typeof obj !== 'object') { return undefined; }
    const o = obj as Record<string, any>;

    if (typeof o.file === 'string' && Array.isArray(o.changes)) {
        return {
            id: `recovered_${Date.now()}`,
            name: 'propose_code_fix',
            input: {
                file: o.file,
                changes: o.changes,
                rationale: typeof o.rationale === 'string' ? o.rationale : (o.summary ?? '')
            }
        };
    }
    if (typeof o.summary === 'string' && Object.keys(o).length <= 2) {
        return {
            id: `recovered_${Date.now()}`,
            name: 'finish',
            input: { summary: o.summary }
        };
    }
    return undefined;
}

/** Heuristic for "the model intended to propose a fix but emitted prose/diff instead". */
function looksLikeFixIntent(text: string): boolean {
    if (/```diff/i.test(text)) { return true; }
    if (/^\s*---\s+\S/m.test(text) && /^\s*\+\+\+\s+\S/m.test(text)) { return true; }
    if (/^@@.+@@/m.test(text)) { return true; }
    if (/\bproposed?\s+fix\b/i.test(text)) { return true; }
    // Multiple +/- prefixed lines that look like a manual diff.
    const diffLines = (text.match(/^\s*[-+]\s\S/gm) ?? []).length;
    return diffLines >= 2;
}

function extractFirstJsonObject(text: string): unknown {
    const start = text.indexOf('{');
    if (start < 0) { return undefined; }
    // Walk forward tracking brace depth and string state.
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inStr = false; }
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') { depth++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) {
                const candidate = text.slice(start, i + 1);
                try { return JSON.parse(candidate); } catch { return undefined; }
            }
        }
    }
    return undefined;
}

function abortSignalFrom(token: vscode.CancellationToken): AbortSignal {
    const ctrl = new AbortController();
    if (token.isCancellationRequested) { ctrl.abort(); }
    token.onCancellationRequested(() => ctrl.abort());
    return ctrl.signal;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) { return s; }
    return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function log(out: vscode.OutputChannel, message: string) {
    const ts = new Date().toLocaleTimeString();
    out.appendLine(`[${ts}] ${message}`);
}
