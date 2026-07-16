import * as path from 'path';
import * as vscode from 'vscode';
import {
    addBreakpoint,
    continueDap,
    expandVariable,
    getStackTrace,
    getVariablesForFrame,
    listBreakpoints,
    listLaunchConfigurations,
    removeBreakpoint,
    restartDebugger,
    startDebugger,
    stepIntoDap,
    stepOutDap,
    stepOverDap,
    stopDebugger
} from '../command-interface';
import {
    DebugSessionController,
    DebugTimeoutError,
    NoActiveDebugSessionError
} from '../session/DebugSessionController';
import { showPreviewAndConfirm } from '../orchestrator/diff';
import { TOOLS, type ToolName } from './schemas';
import { validateToolInput } from './validate';

export interface ToolResult {
    content: string;
    isError?: boolean;
    /** Set when the agent should stop the loop (finish or accepted fix). */
    terminal?: { summary: string };
}

export class DebugTools {
    /**
     * Serializes all tool executions. The debugger's armed-waiter pattern and
     * VS Code's single debug session cannot tolerate concurrent operations —
     * and both the built-in agent and the MCP server share one instance.
     */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly controller: DebugSessionController) {}

    dispatch(name: string, input: unknown): Promise<ToolResult> {
        const run = this.queue.then(() => this.dispatchInner(name, input));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async dispatchInner(name: string, input: unknown): Promise<ToolResult> {
        try {
            const schema = TOOLS.find(t => t.name === name);
            if (!schema) {
                return err(`Unknown tool: ${name}`);
            }
            const problems = validateToolInput(schema.input_schema, input ?? {});
            if (problems.length > 0) {
                return err(`Invalid input for ${name}: ${problems.join('; ')}`);
            }
            const args = (input ?? {}) as Record<string, any>;
            switch (name as ToolName) {
                case 'start_debug_session':
                    return await this.startSession(args.configuration);
                case 'add_breakpoint':
                    return await this.addBreakpoint(args);
                case 'remove_breakpoint':
                    return await this.removeBreakpoint(args);
                case 'list_breakpoints':
                    return ok(listBreakpoints());
                case 'continue_execution':
                    return await this.runAndWait(
                        continueDap,
                        args.timeout_ms ?? 15000,
                        args.include_variables === true
                    );
                case 'step_over':
                    return await this.runAndWait(
                        stepOverDap,
                        args.timeout_ms ?? 5000,
                        args.include_variables === true
                    );
                case 'step_into':
                    return await this.runAndWait(
                        stepIntoDap,
                        args.timeout_ms ?? 5000,
                        args.include_variables === true
                    );
                case 'step_out':
                    return await this.runAndWait(
                        stepOutDap,
                        args.timeout_ms ?? 5000,
                        args.include_variables === true
                    );
                case 'inspect_variables':
                    return ok(
                        await getVariablesForFrame(
                            await this.resolveFrameId(args),
                            this.controller.lastStopEvent?.threadId,
                            this.controller.dapSession
                        )
                    );
                case 'expand_variable':
                    return ok(
                        await expandVariable(args.variables_reference, this.controller.dapSession)
                    );
                case 'get_stack_trace':
                    return ok(
                        await getStackTrace(
                            this.controller.lastStopEvent?.threadId,
                            this.controller.dapSession
                        )
                    );
                case 'read_source':
                    return await this.readSource(args);
                case 'restart_debug_session':
                    await restartDebugger();
                    return await this.waitForStopOrTerminate(15000, 'restarted');
                case 'stop_debug_session':
                    await stopDebugger();
                    return ok({ stopped: true });
                case 'propose_code_fix':
                    return await this.proposeFix(args);
                case 'get_debugger_state':
                    return ok({
                        session_active: !!this.controller.session,
                        session_type: this.controller.session?.type,
                        paused: this.controller.paused,
                        last_stop: this.controller.lastStopEvent ?? null,
                        breakpoints: listBreakpoints(),
                        launch_configurations: listLaunchConfigurations()
                    });
                case 'finish':
                    return {
                        content: JSON.stringify({ finished: true, summary: args.summary ?? '' }),
                        terminal: { summary: args.summary ?? '' }
                    };
                default:
                    return err(`Unknown tool: ${name}`);
            }
        } catch (e) {
            if (e instanceof NoActiveDebugSessionError) {
                return err(
                    'No active debug session. Call start_debug_session first, or set breakpoints and start.'
                );
            }
            if (e instanceof DebugTimeoutError) {
                return err(e.message);
            }
            return err(e instanceof Error ? e.message : String(e));
        }
    }

    /**
     * Resolve a 0-based frame_index from the model into a real DAP frameId.
     * Also tolerates a model that passes a real `frame_id` (as returned in
     * stack traces) by matching it against the current stack by identity.
     * Falls back to the top frame when neither is given.
     */
    private async resolveFrameId(args: Record<string, any>): Promise<number | undefined> {
        const idx = typeof args.frame_index === 'number' ? args.frame_index : undefined;
        const id = typeof args.frame_id === 'number' ? args.frame_id : undefined;
        if (idx === undefined && id === undefined) { return undefined; }
        const frames = await getStackTrace(
            this.controller.lastStopEvent?.threadId,
            this.controller.dapSession
        );
        if (idx !== undefined) {
            if (idx < 0 || idx >= frames.length) {
                throw new Error(
                    `frame_index ${idx} out of range (stack depth ${frames.length})`
                );
            }
            return frames[idx].id;
        }
        if (frames.some(f => f.id === id)) {
            return id;
        }
        throw new Error(
            `frame_id ${id} does not match any current stack frame. Pass frame_index (0..${Math.max(0, frames.length - 1)}) instead.`
        );
    }

    private async startSession(configurationName?: string): Promise<ToolResult> {
        if (this.controller.session) {
            return ok({ alreadyRunning: true, type: this.controller.session.type });
        }
        await startDebugger(configurationName);
        // Many adapters emit a stopped event on entry; wait briefly but don't fail if not.
        try {
            const evt = await this.controller.waitForStop(8000);
            return ok({ started: true, firstEvent: evt });
        } catch {
            return ok({ started: true, firstEvent: null });
        }
    }

    private async addBreakpoint(args: any): Promise<ToolResult> {
        if (!args.file || typeof args.line !== 'number') {
            return err('add_breakpoint requires {file, line}');
        }
        await addBreakpoint(args.file, args.line, args.condition);
        return ok({ added: { file: args.file, line: args.line, condition: args.condition } });
    }

    private async removeBreakpoint(args: any): Promise<ToolResult> {
        if (!args.file || typeof args.line !== 'number') {
            return err('remove_breakpoint requires {file, line}');
        }
        const removed = await removeBreakpoint(args.file, args.line);
        return ok({ removed });
    }

    private async runAndWait(
        fn: (threadId?: number, session?: vscode.DebugSession) => Promise<void>,
        timeoutMs: number,
        includeVariables: boolean
    ): Promise<ToolResult> {
        const threadId = this.controller.lastStopEvent?.threadId;
        const seqBefore = this.controller.stopSeq;
        // Arm the waiter before issuing the command so we don't miss a fast event.
        const wait = this.controller.waitForStop(timeoutMs);
        try {
            await fn(threadId, this.controller.dapSession);
        } catch (e) {
            // Swallow the (now unobserved) waiter rejection and surface the
            // command failure instead.
            wait.catch(() => {});
            throw e;
        }
        try {
            return await this.collectStopResult(wait, includeVariables);
        } catch (e) {
            if (e instanceof DebugTimeoutError) {
                return this.handleStopTimeout(seqBefore, timeoutMs, includeVariables);
            }
            throw e;
        }
    }

    /**
     * The waiter timed out — but the stop may have landed a beat later (its
     * fan-out found no waiters). Check the controller's stop counter before
     * declaring the program still running.
     */
    private async handleStopTimeout(
        seqBefore: number,
        timeoutMs: number,
        includeVariables: boolean
    ): Promise<ToolResult> {
        if (this.controller.stopSeq > seqBefore && this.controller.lastStopEvent) {
            return await this.collectStopResult(
                Promise.resolve(this.controller.lastStopEvent),
                includeVariables
            );
        }
        if (!this.controller.session) {
            return ok({ status: 'terminated', note: 'The debug session ended.' });
        }
        return ok({
            status: 'running',
            note: `No stop event within ${timeoutMs}ms — the program is still executing (or waiting on I/O). It may hit a breakpoint later; retry with a larger timeout_ms or add a breakpoint it will reach.`
        });
    }

    private async waitForStopOrTerminate(
        timeoutMs: number,
        labelIfTimeout: string
    ): Promise<ToolResult> {
        const seqBefore = this.controller.stopSeq;
        try {
            const evt = await this.controller.waitForStop(timeoutMs);
            return await this.collectStopResult(Promise.resolve(evt), false);
        } catch (e) {
            if (e instanceof DebugTimeoutError) {
                return await this.handleStopTimeout(seqBefore, timeoutMs, false);
            }
            return ok({ status: labelIfTimeout, note: 'no stop event within timeout' });
        }
    }

    private async collectStopResult(
        waiter: Promise<any>,
        includeVariables: boolean
    ): Promise<ToolResult> {
        const evt = await waiter;
        if (evt?.reason === 'terminated') {
            return ok({ status: 'terminated' });
        }
        // Pull the top frame for the new pause point. Use the threadId carried
        // by the DAP stopped event itself — VS Code's activeStackItem is
        // populated asynchronously and is often still empty at this instant.
        const threadId: number | undefined = evt?.threadId;
        const dapSession = this.controller.dapSession;
        let frames: Awaited<ReturnType<typeof getStackTrace>> = [];
        try {
            frames = await getStackTrace(threadId, dapSession);
            if (frames.length === 0) {
                // Some adapters need a beat after `stopped` before frames exist.
                await delay(150);
                frames = await getStackTrace(threadId, dapSession);
            }
        } catch { /* may not be paused yet */ }
        const topFrame = frames[0] ?? null;

        // Full variable snapshots on every step bloat the conversation; default
        // to a small locals preview and let the model opt into the full dump.
        let variables: any = undefined;
        let localsPreview: any = undefined;
        if (topFrame) {
            try {
                const scopes = await getVariablesForFrame(topFrame.id, threadId, dapSession);
                if (includeVariables) {
                    variables = scopes;
                } else {
                    const locals =
                        scopes.find(s => /local/i.test(s.scope)) ?? scopes[0];
                    if (locals) {
                        localsPreview = {
                            scope: locals.scope,
                            variables: locals.variables.slice(0, 15).map(v => ({
                                name: v.name,
                                value: truncateValue(v.value, 120)
                            })),
                            ...(locals.truncated || locals.variables.length > 15
                                ? { truncated: true, note: 'Preview only — call inspect_variables for the full snapshot.' }
                                : {})
                        };
                    }
                }
            } catch { /* not paused on a frame */ }
        }
        return ok({
            status: 'stopped',
            stop: evt,
            top_frame: topFrame,
            ...(variables !== undefined ? { variables } : {}),
            ...(localsPreview !== undefined ? { locals_preview: localsPreview } : {})
        });
    }

    /**
     * Read a workspace file. Restricted to within an open workspace folder
     * to keep the agent away from arbitrary host-filesystem reads (e.g. ~/.ssh).
     */
    private async readSource(args: any): Promise<ToolResult> {
        if (typeof args.file !== 'string' || !args.file) {
            return err('read_source requires {file}');
        }
        const resolved = resolveWorkspaceFile(args.file);
        if ('error' in resolved) {
            return err(resolved.error);
        }
        const target = resolved.path;

        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
        } catch (e) {
            return err(`Cannot read ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
        }

        const text = new TextDecoder('utf-8').decode(bytes);
        const lines = text.split(/\r?\n/);
        const total = lines.length;
        const start = clamp(args.start_line ?? 1, 1, Math.max(1, total));
        const end = clamp(args.end_line ?? Math.min(start + 500, total), start, total);
        const slice = lines.slice(start - 1, end);
        const numbered = slice.map((l, i) => `${start + i}: ${l}`).join('\n');
        return ok({
            file: args.file,
            start_line: start,
            end_line: end,
            total_lines: total,
            content: numbered
        });
    }

    private async proposeFix(args: any): Promise<ToolResult> {
        if (!args.file || !Array.isArray(args.changes) || args.changes.length === 0) {
            return err('propose_code_fix requires {file, changes[]}');
        }
        const resolved = resolveWorkspaceFile(args.file);
        if ('error' in resolved) {
            return err(resolved.error);
        }

        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(resolved.path);
        } catch (e) {
            return err(`Cannot open ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Validate each change against the real file before building ranges —
        // a hallucinated line number must fail loudly, not silently clamp onto
        // the wrong region. Lines are 1-indexed (agent convention, matching
        // read_source output); columns 0-indexed.
        const ranges: { range: vscode.Range; newText: string }[] = [];
        for (let i = 0; i < args.changes.length; i++) {
            const c = args.changes[i];
            const startLine = Number(c?.start_line);
            const endLine = Number(c?.end_line);
            if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
                return err(`propose_code_fix change #${i + 1}: start_line/end_line must be integers.`);
            }
            if (startLine < 1 || endLine < startLine || endLine > doc.lineCount) {
                return err(
                    `propose_code_fix change #${i + 1}: lines ${startLine}-${endLine} invalid — ${args.file} has ${doc.lineCount} lines (1-indexed) and end_line must be >= start_line. Re-read the file with read_source and use the line numbers it shows.`
                );
            }
            if (typeof c.new_text !== 'string') {
                return err(`propose_code_fix change #${i + 1}: new_text must be a string.`);
            }
            // Clamp columns to real line lengths (models often guess end_char).
            const startChar = clamp(Number(c.start_char) || 0, 0, doc.lineAt(startLine - 1).text.length);
            const endChar = clamp(Number(c.end_char) || 0, 0, doc.lineAt(endLine - 1).text.length);
            ranges.push({
                range: new vscode.Range(
                    new vscode.Position(startLine - 1, startChar),
                    new vscode.Position(endLine - 1, endChar)
                ),
                newText: c.new_text
            });
        }

        // Reject overlapping ranges — VS Code would misapply or refuse them.
        const sorted = [...ranges].sort((a, b) => doc.offsetAt(a.range.start) - doc.offsetAt(b.range.start));
        for (let i = 1; i < sorted.length; i++) {
            if (doc.offsetAt(sorted[i].range.start) < doc.offsetAt(sorted[i - 1].range.end)) {
                return err(
                    'propose_code_fix: changes overlap each other. Merge overlapping edits into a single change.'
                );
            }
        }

        const result = await showPreviewAndConfirm(resolved.path, ranges);
        return {
            content: JSON.stringify({
                proposed: true,
                accepted: result.accepted,
                rationale: args.rationale,
                note: result.accepted
                    ? 'User accepted and the file was saved.'
                    : result.note ?? 'User rejected the proposed changes. Reconsider or finish.'
            })
        };
    }
}

/**
 * Resolve a model-supplied path and require it to be inside an open workspace
 * folder — keeps the agent (and external MCP clients) away from arbitrary
 * host-filesystem access.
 */
function resolveWorkspaceFile(file: string): { path: string } | { error: string } {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return { error: 'No open workspace folder; cannot resolve file path.' };
    }
    const target = path.resolve(file);
    const inWorkspace = folders.some(f => {
        const root = f.uri.fsPath;
        return target === root || target.startsWith(root + path.sep);
    });
    if (!inWorkspace) {
        return {
            error: `Path is outside the open workspace: ${file}. Open the relevant folder in VS Code first.`
        };
    }
    return { path: target };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function truncateValue(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…(${s.length - max} more chars)` : s;
}

function clamp(n: number, lo: number, hi: number): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) { return lo; }
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function ok(payload: unknown): ToolResult {
    // Compact JSON — pretty-printing costs whitespace tokens on every result.
    return { content: JSON.stringify(payload) };
}

function err(message: string): ToolResult {
    return { content: JSON.stringify({ error: message }), isError: true };
}
