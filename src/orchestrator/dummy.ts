import * as vscode from 'vscode';
import { startDebugger, continueExecution, stepOver, stepInto, stepOut, restartDebugger, stopDebugger, addBreakpoints, testAddingBreakpoints } from '../command-interface';
import { showPreviewAndConfirm } from './diff';

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// TODO: Is file chosen in the command-interface.ts
export async function startDummyAgent(): Promise<void> {
    vscode.window.showInformationMessage('Dummy agent: starting test sequence');

    try {
        // Try to start the debugger (will prompt user if launch.json missing)
        await startDebugger();
        await sleep(1200);

        // Try adding a breakpoint at the current cursor location (if an editor is open)
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage('No active file open');
            return;
        }
        const filePath = activeEditor.document.uri.fsPath;
        await addBreakpoints(filePath, 3);
        await sleep(600);

        // Continue, then step over, step into, step out in sequence to exercise the commands
        continueExecution();
        await sleep(500);

        stepOver();
        await sleep(400);

        stepInto();
        await sleep(400);

        stepOut();
        await sleep(400);

        // Restart then stop to exercise those functions as well
        restartDebugger();
        await sleep(3000);

        stopDebugger();
        await sleep(3000);

        if (activeEditor) {
            const filePath = activeEditor.document.uri.fsPath;
            await showPreviewAndConfirm(filePath, [{range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)), newText: '# Modified line example'},
                {range: new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 5)), newText: '# Changed'}]);
        } else {
            vscode.window.showInformationMessage('No active editor to show diff for');
        }
        await sleep(1000);

        vscode.window.showInformationMessage('Dummy agent: test sequence completed');
    } catch (err) {
        // Show any error but continue gracefully
        vscode.window.showErrorMessage(`Dummy agent error: ${err}`);
    }
}

export default startDummyAgent;
