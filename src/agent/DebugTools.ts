import * as path from 'path';
import * as vscode from 'vscode';
import {
    addBreakpoint,
    continueExecution,
    expandVariable,
    getStackTrace,
    getVariablesForFrame,
    listBreakpoints,
    removeBreakpoint,
    restartDebugger,
    startDebugger,
    stepInto,
    stepOut,
    stepOver,
    stopDebugger
} from '../command-interface';
import {
    DebugSessionController,
    DebugTimeoutError,
    NoActiveDebugSessionError
} from '../session/DebugSessionController';
import { showPreviewAndConfirm } from '../orchestrator/diff';
import type { ToolName } from './schemas';

export interface ToolResult {
    content: string;
    isError?: boolean;
    /** Set when the agent should stop the loop (finish or accepted fix). */
    terminal?: { summary: string };
}

export class DebugTools {
    constructor(private readonly controller: DebugSessionController) {}

    async dispatch(name: string, input: unknown): Promise<ToolResult> {
        try {
            const args = (input ?? {}) as Record<string, any>;
            switch (name as ToolName) {
                case 'start_debug_session':
                    return await this.startSession();
                case 'add_breakpoint':
                    return await this.addBreakpoint(args);
                case 'remove_breakpoint':
                    return await this.removeBreakpoint(args);
                case 'list_breakpoints':
                    return ok(listBreakpoints());
                case 'continue_execution':
                    return await this.runAndWait(continueExecution, args.timeout_ms ?? 15000);
                case 'step_over':
                    return await this.runAndWait(stepOver, args.timeout_ms ?? 5000);
                case 'step_into':
                    return await this.runAndWait(stepInto, args.timeout_ms ?? 5000);
                case 'step_out':
                    return await this.runAndWait(stepOut, args.timeout_ms ?? 5000);
                case 'inspect_variables':
                    return ok(await getVariablesForFrame(await this.resolveFrameId(args)));
                case 'expand_variable':
                    return ok(await expandVariable(args.variables_reference));
                case 'get_stack_trace':
                    return ok(await getStackTrace());
                case 'read_source':
                    return await this.readSource(args);
                case 'restart_debug_session':
                    await restartDebugger();
                    return await this.waitForStopOrTerminate(15000, 'restarted');
                case 'stop_debug_session':
                    stopDebugger();
                    return ok({ stopped: true });
                case 'propose_code_fix':
                    return await this.proposeFix(args);
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
     * Falls back to the active stack item's frameId when no index is given or
     * the stack trace can't be fetched (e.g. not paused).
     */
    private async resolveFrameId(args: Record<string, any>): Promise<number | undefined> {
        const idx =
            typeof args.frame_index === 'number'
                ? args.frame_index
                : typeof args.frame_id === 'number' && args.frame_id < 100
                ? args.frame_id // tolerate model that emitted frame_id-as-index
                : undefined;
        if (idx === undefined) { return undefined; }
        try {
            const frames = await getStackTrace();
            if (idx < 0 || idx >= frames.length) {
                throw new Error(
                    `frame_index ${idx} out of range (stack depth ${frames.length})`
                );
            }
            return frames[idx].id;
        } catch (e) {
            if (e instanceof NoActiveDebugSessionError) { throw e; }
            // Fall back to top frame on any other failure.
            return undefined;
        }
    }

    private async startSession(): Promise<ToolResult> {
        if (this.controller.session) {
            return ok({ alreadyRunning: true, type: this.controller.session.type });
        }
        await startDebugger();
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
        fn: () => Promise<void>,
        timeoutMs: number
    ): Promise<ToolResult> {
        // Arm the waiter before issuing the command so we don't miss a fast event.
        const wait = this.controller.waitForStop(timeoutMs);
        await fn();
        return await this.collectStopResult(wait);
    }

    private async waitForStopOrTerminate(
        timeoutMs: number,
        labelIfTimeout: string
    ): Promise<ToolResult> {
        try {
            const evt = await this.controller.waitForStop(timeoutMs);
            return await this.collectStopResult(Promise.resolve(evt));
        } catch {
            return ok({ status: labelIfTimeout, note: 'no stop event within timeout' });
        }
    }

    private async collectStopResult(
        waiter: Promise<any>
    ): Promise<ToolResult> {
        const evt = await waiter;
        if (evt?.reason === 'terminated') {
            return ok({ status: 'terminated' });
        }
        // Pull top frame + variables snapshot for the new pause point.
        let topFrame: any = null;
        let variables: any = null;
        try {
            const frames = await getStackTrace();
            topFrame = frames[0] ?? null;
        } catch { /* may not be paused yet */ }
        try {
            variables = await getVariablesForFrame();
        } catch { /* not paused on a frame */ }
        return ok({
            status: 'stopped',
            stop: evt,
            top_frame: topFrame,
            variables
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
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
            return err('No open workspace folder; cannot resolve file path.');
        }
        const target = path.resolve(args.file);
        const inWorkspace = folders.some(f => {
            const root = f.uri.fsPath;
            return target === root || target.startsWith(root + path.sep);
        });
        if (!inWorkspace) {
            return err(
                `Path is outside the open workspace: ${args.file}. Open the relevant folder in VS Code first.`
            );
        }

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
        if (!args.file || !Array.isArray(args.changes)) {
            return err('propose_code_fix requires {file, changes[]}');
        }
        // Convert 1-indexed lines (agent convention, matches read_source output)
        // to 0-indexed positions (VS Code convention).
        const ranges = args.changes.map((c: any) => {
            const startLine = Math.max(0, (Number(c.start_line) || 1) - 1);
            const endLine = Math.max(startLine, (Number(c.end_line) || 1) - 1);
            return {
                range: new vscode.Range(
                    new vscode.Position(startLine, Math.max(0, Number(c.start_char) || 0)),
                    new vscode.Position(endLine, Math.max(0, Number(c.end_char) || 0))
                ),
                newText: c.new_text
            };
        });
        const accepted = await showPreviewAndConfirm(args.file, ranges);
        return {
            content: JSON.stringify({
                proposed: true,
                accepted,
                rationale: args.rationale,
                note: accepted
                    ? 'User accepted and the file was saved.'
                    : 'User rejected the proposed changes. Reconsider or finish.'
            })
        };
    }
}

function clamp(n: number, lo: number, hi: number): number {
    if (typeof n !== 'number' || !Number.isFinite(n)) { return lo; }
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function ok(payload: unknown): ToolResult {
    return { content: JSON.stringify(payload, null, 2) };
}

function err(message: string): ToolResult {
    return { content: JSON.stringify({ error: message }), isError: true };
}
