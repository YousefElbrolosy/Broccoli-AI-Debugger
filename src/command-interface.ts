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

export async function getDebugVariablesFromStackFrame() {
    /**
     * Gets the variables from the current debug session and the active StackItem.
    */
    const session = vscode.debug.activeDebugSession;
    
    if (!session) {
        vscode.window.showInformationMessage('No active debug session');
        return null;
    }

    const activeStack = vscode.debug.activeStackItem;

    

    if (!activeStack) {
        vscode.window.showWarningMessage('No active stack frame selected');
        return null;
    }

    // Validate we're working with the correct session
    if (activeStack.session.id !== session.id) {
        vscode.window.showErrorMessage(
            `Session mismatch: active session changed during operation`
        );
        return null;
    }

    try {
        if (!('frameId' in activeStack)) {
            vscode.window.showWarningMessage('Active stack item is not a stack frame');
            return null;
        }

        const frameId = activeStack.frameId;

        console.log("frameId", frameId);

        const scopes = await session.customRequest('scopes', { frameId });
        
        const variables: any[] = [];
        
        // Get variables for each scope
        for (const scope of scopes.scopes) {
            const scopeVars = await session.customRequest('variables', {
                variablesReference: scope.variablesReference
            });
            
            variables.push({
                scope: scope.name,
                variables: scopeVars.variables
            });
        }
        
        return variables;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to retrieve debug variables: ${message}`);
        console.error('Debug variables error:', error);
        return null;
    }
}

export async function inspectVariables() {
    const variables = await getDebugVariablesFromStackFrame();
    vscode.window.showInformationMessage('Variables fetched. Check output for details.');
    console.log('Debug Variables:', variables);
    if (variables) {
        // Log to console or display as needed
        console.log(JSON.stringify(variables, null, 2));
        
        // Or show in output channel
        const outputChannel = vscode.window.createOutputChannel('Debug Variables');
        outputChannel.show();
        outputChannel.appendLine(JSON.stringify(variables, null, 2));
    }
}