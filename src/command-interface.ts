import * as vscode from 'vscode';
import { NoActiveDebugSessionError } from './session/DebugSessionController';

export async function startDebugger(): Promise<void> {
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
    if (configurations.length === 1) {
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

function requireSession(): vscode.DebugSession {
    const s = vscode.debug.activeDebugSession;
    if (!s) {
        throw new NoActiveDebugSessionError();
    }
    return s;
}

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

export async function restartDebugger(): Promise<void> {
    requireSession();
    await vscode.commands.executeCommand('workbench.action.debug.restart');
}

export function stopDebugger(): void {
    const s = vscode.debug.activeDebugSession;
    if (!s) {
        throw new NoActiveDebugSessionError();
    }
    vscode.debug.stopDebugging(s);
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

export async function getStackTrace(): Promise<
    Array<{ id: number; name: string; source?: string; line: number }>
> {
    const session = requireSession();
    const threadId = inferThreadId();
    if (threadId === undefined) {
        return [];
    }
    const result = await session.customRequest('stackTrace', { threadId, levels: 20 });
    return (result?.stackFrames ?? []).map((f: any) => ({
        id: f.id,
        name: f.name,
        source: f.source?.path,
        line: f.line
    }));
}

export async function getVariablesForFrame(frameId?: number): Promise<ScopeSummary[]> {
    const session = requireSession();
    const fid = frameId ?? topFrameIdOrThrow();
    const scopesResp = await session.customRequest('scopes', { frameId: fid });
    const scopes = scopesResp?.scopes ?? [];
    const out: ScopeSummary[] = [];
    for (const scope of scopes) {
        const vars = await session.customRequest('variables', {
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

export async function expandVariable(variablesReference: number): Promise<VariableSummary[]> {
    const session = requireSession();
    const vars = await session.customRequest('variables', { variablesReference });
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

function inferThreadId(): number | undefined {
    const item = vscode.debug.activeStackItem;
    if (!item) {
        return undefined;
    }
    return item.threadId;
}

function topFrameIdOrThrow(): number {
    const item = vscode.debug.activeStackItem;
    if (!item || !('frameId' in item)) {
        throw new Error('Debugger is not paused on a stack frame');
    }
    return (item as vscode.DebugStackFrame).frameId;
}
