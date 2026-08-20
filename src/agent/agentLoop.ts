import * as vscode from 'vscode';
import { DebugTools } from './DebugTools';
import { AGENT_TOOLS, TOOLS } from './schemas';
import { SYSTEM_PROMPT } from './systemPrompt';
import type { DebugSessionController } from '../session/DebugSessionController';
import { createClient } from './llm';
import type { LLMClient, NormalizedMessage, NormalizedToolCall, ProviderConfig } from './llm';
import type { AgentState } from './AgentState';
import { compactHistory, estimateChars } from './history';

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TOKEN_BUDGET = 200_000;
const MAX_TOOL_RESULT_CHARS = 8000;
/** Only compact above this estimated prompt size — compaction invalidates the provider's message cache once. */
const COMPACT_TRIGGER_CHARS = 60_000;
const KEEP_RECENT_TOOL_RESULTS = 6;

export interface AgentRunOptions {
    config: ProviderConfig;
    controller: DebugSessionController;
    initialUserMessage: string;
    output: vscode.OutputChannel;
    cancel: vscode.CancellationToken;
    maxTurns?: number;
    state?: AgentState;
    /** Shared tool dispatcher (also used by the MCP server); created ad hoc when absent. */
    debugTools?: DebugTools;
}

export async function runAgent(opts: AgentRunOptions): Promise<{
    finished: boolean;
    summary?: string;
    turns: number;
}> {
    const { config, controller, initialUserMessage, output, cancel, state } = opts;
    const settings = vscode.workspace.getConfiguration('broccoli.agent');
    const maxTurns = opts.maxTurns ?? settings.get<number>('maxTurns', DEFAULT_MAX_TURNS);
    const tokenBudget = settings.get<number>('tokenBudget', DEFAULT_TOKEN_BUDGET);

    const client: LLMClient = createClient(config);
    const tools = opts.debugTools ?? new DebugTools(controller);

    log(output, `Using ${client.label} (maxTurns=${maxTurns}, tokenBudget=${tokenBudget || 'unlimited'})`);
    state?.resetUsage(tokenBudget > 0 ? tokenBudget : 0);

    const messages: NormalizedMessage[] = [
        { role: 'user', content: initialUserMessage }
    ];

    let turns = 0;
    let summary: string | undefined;
    let finished = false;
    let nudgesUsed = 0;
    const MAX_NUDGES = 2;
    let totalTokens = 0;
    // Stop-controller: precedence cancel > budget > turns. When budget or the
    // turn limit is about to bite, inject a single wrap-up nudge and allow
    // exactly one more turn.
    let wrapUpInjected = false;
    let turnsSinceWrapUp = 0;

    while (turns < maxTurns) {
        if (cancel.isCancellationRequested) {
            log(output, 'Cancelled by user.');
            break;
        }
        if (wrapUpInjected && turnsSinceWrapUp >= 1) {
            log(output, 'Hard stop: wrap-up turn used without finish.');
            break;
        }
        turns++;
        if (wrapUpInjected) { turnsSinceWrapUp++; }
        log(output, `--- Turn ${turns}/${maxTurns} ---`);
        state?.set({ kind: 'running', turn: turns, maxTurns });

        if (estimateChars(messages) > COMPACT_TRIGGER_CHARS) {
            const compacted = compactHistory(messages, {
                keepRecentToolResults: KEEP_RECENT_TOOL_RESULTS
            });
            if (compacted.pruned > 0) {
                messages.splice(0, messages.length, ...compacted.messages);
                log(
                    output,
                    `Compacted history: stubbed ${compacted.pruned} old tool result(s), ~${compacted.savedChars} chars saved.`
                );
            }
        }

        let resp;
        try {
            resp = await client.step({
                system: SYSTEM_PROMPT,
                tools: AGENT_TOOLS,
                messages,
                signal: abortSignalFrom(cancel)
            });
        } catch (e) {
            if (cancel.isCancellationRequested) { break; }
            log(output, `API error: ${e instanceof Error ? e.message : String(e)}`);
            throw e;
        }

        if (resp.usage) {
            const u = resp.usage;
            totalTokens += u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
            state?.addUsage({ ...u, turns });
            log(
                output,
                `usage: in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens} (run total ${totalTokens})`
            );
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
            const toolSeq = state?.startTool(turns, call.name, summarizeArgs(call.input));
            const startedAt = Date.now();
            const result = await tools.dispatch(call.name, call.input);
            if (toolSeq !== undefined) {
                state?.finishTool(toolSeq, result.isError ? 'error' : 'ok', Date.now() - startedAt);
            }
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

        if (!wrapUpInjected) {
            const budgetHit = tokenBudget > 0 && totalTokens >= tokenBudget;
            const turnsNearlyOut = turns >= maxTurns - 1;
            if (budgetHit || turnsNearlyOut) {
                wrapUpInjected = true;
                const reason = budgetHit
                    ? `token budget (${tokenBudget} tokens)`
                    : `turn limit (${maxTurns} turns)`;
                log(output, `Injecting wrap-up nudge — reached the ${reason}.`);
                messages.push({
                    role: 'user',
                    content: `You have reached the ${reason} for this run. Call finish NOW with your best summary: what you observed, your current hypothesis, and what you would try next. Do not call any other tool.`
                });
            }
        }
    }

    if (turns >= maxTurns && !finished) {
        log(output, `Reached MAX_TURNS=${maxTurns} without finish.`);
    }
    return { finished, summary, turns };
}

/**
 * Try to recover a tool call from plain assistant text. Handles two families:
 *  1. An envelope naming any known tool: {name|tool: "...", input|arguments|parameters: {...}}
 *     (or the arguments flattened alongside the name).
 *  2. Bare payloads for the two tools models most often dump verbatim:
 *     propose_code_fix ({file, changes}) and finish ({summary}).
 * Exported for unit tests.
 */
export function recoverToolCallFromText(text: string): NormalizedToolCall | undefined {
    const obj = extractFirstJsonObject(text);
    if (!obj || typeof obj !== 'object') { return undefined; }
    const o = obj as Record<string, any>;

    const knownNames = new Set(TOOLS.map(t => t.name));
    const envelopeName =
        typeof o.name === 'string' && knownNames.has(o.name)
            ? o.name
            : typeof o.tool === 'string' && knownNames.has(o.tool)
            ? o.tool
            : undefined;
    if (envelopeName) {
        const nested = o.input ?? o.arguments ?? o.parameters ?? o.args;
        let input: any;
        if (nested && typeof nested === 'object') {
            input = nested;
        } else {
            // Arguments flattened next to the tool name.
            input = { ...o };
            delete input.name;
            delete input.tool;
        }
        return { id: `recovered_${Date.now()}`, name: envelopeName, input };
    }

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

/** Heuristic for "the model intended to propose a fix but emitted prose/diff instead". Exported for unit tests. */
export function looksLikeFixIntent(text: string): boolean {
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

/** Compact one-line rendering of tool arguments for the sidebar timeline. */
function summarizeArgs(input: unknown): string {
    if (input === null || input === undefined) { return ''; }
    let s: string;
    try {
        s = JSON.stringify(input);
    } catch {
        s = String(input);
    }
    if (s === '{}') { return ''; }
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
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
