import * as vscode from 'vscode';
import { NoActiveDebugSessionError } from './session/DebugSessionController';

export async function startDebugger(configurationName?: string): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        throw new Error('No workspace folder open');
    }

    const configs = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
    const configurations = configs.get<any[]>('configurations', []);

    if (configurations.length === 0) {
        throw new Error('No debug configurations found in launch.json');
    }

    let configToLaunch;
    if (configurationName) {
        configToLaunch = configurations.find(c => c.name === configurationName);
        if (!configToLaunch) {
            throw new Error(
                `No launch configuration named "${configurationName}". Available: ${configurations
                    .map(c => c.name)
                    .join(', ')}`
            );
        }
    } else if (configurations.length === 1) {
        configToLaunch = configurations[0];
    } else {
        const selected = await vscode.window.showQuickPick(
            configurations.map(c => c.name),
            { placeHolder: 'Select a debug configuration' }
        );
        if (!selected) {
            throw new Error('No debug configuration selected');
        }
        configToLaunch = configurations.find(c => c.name === selected);
    }

    const ok = await vscode.debug.startDebugging(workspaceFolder, configToLaunch);
    if (!ok) {
        throw new Error('vscode.debug.startDebugging returned false');
    }
}

/** Names of the launch configurations available in the first workspace folder. */
export function listLaunchConfigurations(): string[] {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) { return []; }
    return vscode.workspace
        .getConfiguration('launch', workspaceFolder.uri)
        .get<any[]>('configurations', [])
        .map(c => String(c.name));
}

function requireSession(preferred?: vscode.DebugSession): vscode.DebugSession {
    const s = preferred ?? vscode.debug.activeDebugSession;
    if (!s) {
        throw new NoActiveDebugSessionError();
    }
    return s;
}

const DAP_REQUEST_TIMEOUT_MS = 10_000;

/**
 * customRequest with a hard timeout. Some adapters (e.g. js-debug's parent
 * session) log "Unknown request" and never respond — an unresolved promise
 * here would wedge the tool-dispatch queue forever.
 */
function dapRequest(
    session: vscode.DebugSession,
    command: string,
    args?: unknown
): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`DAP ${command} request timed out after ${DAP_REQUEST_TIMEOUT_MS}ms`)),
            DAP_REQUEST_TIMEOUT_MS
        );
        Promise.resolve(session.customRequest(command, args)).then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });
}

// UI-driven wrappers: act on VS Code's focused session/thread. Used by the
// manual palette commands where "whatever the user is looking at" is correct.
export async function continueExecution(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.continue');
}

export async function stepOver(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.stepOver');
}

export async function stepInto(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.stepInto');
}

export async function stepOut(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.stepOut');
}

// DAP-driven variants: target an explicit threadId (and session) so the agent
// controls the thread it observed stopping, not whichever has UI focus.
export async function continueDap(threadId?: number, session?: vscode.DebugSession): Promise<void> {
    const s = requireSession(session);
    await dapRequest(s, 'continue', { threadId: await resolveThreadId(s, threadId) });
}

export async function stepOverDap(threadId?: number, session?: vscode.DebugSession): Promise<void> {
    const s = requireSession(session);
    await dapRequest(s, 'next', { threadId: await resolveThreadId(s, threadId) });
}

export async function stepIntoDap(threadId?: number, session?: vscode.DebugSession): Promise<void> {
    const s = requireSession(session);
    await dapRequest(s, 'stepIn', { threadId: await resolveThreadId(s, threadId) });
}

export async function stepOutDap(threadId?: number, session?: vscode.DebugSession): Promise<void> {
    const s = requireSession(session);
    await dapRequest(s, 'stepOut', { threadId: await resolveThreadId(s, threadId) });
}

export async function restartDebugger(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.restart');
}

export async function stopDebugger(): Promise<void> {
    const s = vscode.debug.activeDebugSession;
    if (!s) {
        throw new NoActiveDebugSessionError();
    }
    await vscode.debug.stopDebugging(s);
}

export async function addBreakpoint(file: string, line: number, condition?: string): Promise<void> {
    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(line - 1, 0);
    const location = new vscode.Location(uri, position);
    const breakpoint = new vscode.SourceBreakpoint(location, true, condition);
    vscode.debug.addBreakpoints([breakpoint]);
}

export async function removeBreakpoint(file: string, line: number): Promise<boolean> {
    const uri = vscode.Uri.file(file);
    const target = vscode.debug.breakpoints.find(
        bp =>
            bp instanceof vscode.SourceBreakpoint &&
            bp.location.uri.fsPath === uri.fsPath &&
            bp.location.range.start.line === line - 1
    );
    if (!target) {
        return false;
    }
    vscode.debug.removeBreakpoints([target]);
    return true;
}

export function listBreakpoints(): Array<{
    file: string;
    line: number;
    enabled: boolean;
    condition?: string;
}> {
    return vscode.debug.breakpoints
        .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
        .map(bp => ({
            file: bp.location.uri.fsPath,
            line: bp.location.range.start.line + 1,
            enabled: bp.enabled,
            condition: bp.condition
        }));
}

export interface VariableSummary {
    name: string;
    value: string;
    type?: string;
    variables_reference: number;
}

export interface ScopeSummary {
    scope: string;
    variables: VariableSummary[];
    truncated?: boolean;
}

const MAX_VARIABLES_PER_SCOPE = 50;

export interface StackFrameSummary {
    id: number;
    name: string;
    source?: string;
    line: number;
}

export async function getStackTrace(
    threadId?: number,
    session?: vscode.DebugSession
): Promise<StackFrameSummary[]> {
    const s = requireSession(session);
    const tid = await resolveThreadId(s, threadId);
    const result = await dapRequest(s, 'stackTrace', { threadId: tid, levels: 20 });
    return (result?.stackFrames ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        source: f.source?.path,
        line: f.line
    }));
}

export async function getVariablesForFrame(
    frameId?: number,
    threadId?: number,
    session?: vscode.DebugSession
): Promise<ScopeSummary[]> {
    const s = requireSession(session);
    let fid = frameId;
    if (fid === undefined) {
        const item = vscode.debug.activeStackItem;
        if (item && 'frameId' in item) {
            fid = (item as vscode.DebugStackFrame).frameId;
        } else {
            const frames = await getStackTrace(threadId, s);
            if (frames.length === 0) {
                throw new Error('Debugger is not paused on a stack frame');
            }
            fid = frames[0].id;
        }
    }
    const scopesResp = await dapRequest(s, 'scopes', { frameId: fid });
    const scopes = scopesResp?.scopes ?? [];
    const out: ScopeSummary[] = [];
    for (const scope of scopes) {
        const vars = await dapRequest(s, 'variables', {
            variablesReference: scope.variablesReference
        });
        const all: any[] = vars?.variables ?? [];
        const truncated = all.length > MAX_VARIABLES_PER_SCOPE;
        out.push({
            scope: scope.name,
            variables: all.slice(0, MAX_VARIABLES_PER_SCOPE).map(summarize),
            truncated
        });
    }
    return out;
}

export async function expandVariable(
    variablesReference: number,
    session?: vscode.DebugSession
): Promise<VariableSummary[]> {
    const s = requireSession(session);
    const vars = await dapRequest(s, 'variables', { variablesReference });
    const all: any[] = vars?.variables ?? [];
    return all.slice(0, MAX_VARIABLES_PER_SCOPE).map(summarize);
}

function summarize(v: any): VariableSummary {
    return {
        name: v.name,
        value: truncate(String(v.value ?? ''), 500),
        type: v.type,
        variables_reference: v.variablesReference ?? 0
    };
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max)}…(${s.length - max} more chars)` : s;
}

/**
 * Resolve the thread to operate on: explicit id (from a DAP stopped event) →
 * VS Code's focused stack item → first thread reported by the adapter.
 * Never depends solely on `activeStackItem`, which VS Code populates
 * asynchronously after a stop and may still be empty when we need it.
 */
async function resolveThreadId(
    session: vscode.DebugSession,
    preferred?: number
): Promise<number> {
    if (typeof preferred === 'number') {
        return preferred;
    }
    const item = vscode.debug.activeStackItem;
    if (item) {
        return item.threadId;
    }
    const resp = await dapRequest(session, 'threads');
    const first = resp?.threads?.[0]?.id;
    if (typeof first === 'number') {
        return first;
    }
    throw new Error('Cannot determine a debug thread (no threads reported by the adapter)');
}
