import * as vscode from 'vscode';

// TODO: check for more edge cases

export async function startDebugger() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const configs = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
    const configurations = configs.get<any[]>('configurations', []);

    if (configurations.length === 0) {
        vscode.window.showErrorMessage('No debug configurations found in launch.json');
        return;
    }

    let configToLaunch;
    if (configurations.length === 1) {
        configToLaunch = configurations[0];
    } else {
        const selected = await vscode.window.showQuickPick(
            configurations.map(c => c.name),
            { placeHolder: 'Select a debug configuration, Go to the Debug tab and select create launch.json file' }
        );
        if (!selected) { return; }
        configToLaunch = configurations.find(c => c.name === selected);
    }

    await vscode.debug.startDebugging(workspaceFolder, configToLaunch);
}

export function continueExecution() {
    if (vscode.debug.activeDebugSession) {
        vscode.commands.executeCommand('workbench.action.debug.continue');
    } else {
        vscode.window.showInformationMessage('No active debug session to continue');
    }
}

export function stepOver() {
    if (vscode.debug.activeDebugSession) {
        vscode.commands.executeCommand('workbench.action.debug.stepOver');
    } else {
        vscode.window.showInformationMessage('No active debug session to step over');
    }
}

export function stepInto() {
    if (vscode.debug.activeDebugSession) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const configs = vscode.workspace.getConfiguration('launch', workspaceFolder?.uri);
        const configurations = configs.get<any[]>('configurations', []);
        const justMyCode = configurations[0]?.justMyCode ?? true;
        if (justMyCode === true || justMyCode === undefined) {
            vscode.window.showWarningMessage('Warning: "Just My Code" is set to true - possibly by default. Step Into would not be able to stepInto external code. If you want to step into external code, please set "justMyCode": false in your launch.json configuration.');
        }
        vscode.commands.executeCommand('workbench.action.debug.stepInto');
    } else {
        vscode.window.showInformationMessage('No active debug session to step into');
    }
}

export function stepOut() {
    if (vscode.debug.activeDebugSession) {
        vscode.commands.executeCommand('workbench.action.debug.stepOut');
    } else {
        vscode.window.showInformationMessage('No active debug session to step out');
    }
}

export function restartDebugger(): void {
    if (vscode.debug.activeDebugSession) {
        vscode.commands.executeCommand('workbench.action.debug.restart');
    } else {
        vscode.window.showInformationMessage('No active debug session to restart');
    }
}

export function stopDebugger(): void {
    if (vscode.debug.activeDebugSession) {
        vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    } else {
        vscode.window.showInformationMessage('No active debug session to stop');
    }
}
export function addBreakpoints(file: string, line: number): void {
    const uri = vscode.Uri.file(file);
    const position = new vscode.Position(line - 1, 0);
    const location = new vscode.Location(uri, position);
    // NOTE: Can also be a function breakpoint -> the name of the function to which this breakpoint is attached.
    // Also a Breakpoint has an attribute conditino to make it a conditiional breakpoint.
    //  */ From Docs:
    //  * An optional expression for conditional breakpoints.
    //  */
    // readonly condition?: string | undefined;
    const breakpoint = new vscode.SourceBreakpoint(location, true);

    vscode.debug.addBreakpoints([breakpoint]);
}

// TODO: Make other add breakpoints functions (function, conditional, etc.)

export async function testBreakpoints(): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showErrorMessage('No active file open');
        return;
    }
    
    const filePath = activeEditor.document.uri.fsPath;
    const currentLine = activeEditor.selection.active.line + 1;
    addBreakpoints(filePath, currentLine);
}