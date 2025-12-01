import { exec } from 'child_process';
import * as vscode from 'vscode';


export async function applyChanges(filePath: string, changes: { range: vscode.Range; newText: string }[]): Promise<void> {
    // Apply edits directly to the original file and save it.
    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    await editor.edit(editBuilder => {
        for (const change of changes) {
            editBuilder.replace(change.range, change.newText);
        }
    });

    await document.save();
}

/**
 * Show a preview diff and prompt the user to accept or reject the proposed edits.
 * If accepted, the edits are applied to the original file and saved.
 */
export async function showPreviewAndConfirm(filePath: string, changes: { range: vscode.Range; newText: string }[]): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(filePath);
        const originalText = document.getText();

        const edits = [...changes];
        edits.sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start));

        let modifiedText = originalText;
        for (const ch of edits) {
            const start = document.offsetAt(ch.range.start);
            const end = document.offsetAt(ch.range.end);
            modifiedText = modifiedText.slice(0, start) + ch.newText + modifiedText.slice(end);
        }

        const previewDoc = await vscode.workspace.openTextDocument({ content: modifiedText, language: document.languageId });
        await vscode.commands.executeCommand('vscode.diff', document.uri, previewDoc.uri, `${filePath} ↔ (preview edits)`);

        const choice = await vscode.window.showInformationMessage('Apply proposed changes?', 'Apply', 'Reject');
        if (choice === 'Apply') {
            await applyChanges(filePath, changes);
            vscode.window.showInformationMessage('Changes applied.');
        } else {
            vscode.window.showInformationMessage('Changes not applied.');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to preview/confirm changes: ${err}`);
    }
}