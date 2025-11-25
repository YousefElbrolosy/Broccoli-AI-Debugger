import * as vscode from 'vscode';

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
        if (!selected) {return;}
        configToLaunch = configurations.find(c => c.name === selected);
    }

    await vscode.debug.startDebugging(workspaceFolder, configToLaunch);
}