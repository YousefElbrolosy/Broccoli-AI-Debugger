import * as vscode from 'vscode';

export interface ProposedChange {
    range: vscode.Range;
    newText: string;
}

export interface ConfirmResult {
    accepted: boolean;
    note?: string;
}

const PREVIEW_SCHEME = 'broccoli-preview';
const previews = new Map<string, string>();
const previewChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

/** Test seam: integration tests can auto-accept/reject instead of showing a modal. */
let confirmOverride: ((filePath: string, changes: ProposedChange[]) => Promise<boolean>) | undefined;
export function __setConfirmOverrideForTests(
    fn: ((filePath: string, changes: ProposedChange[]) => Promise<boolean>) | undefined
): void {
    confirmOverride = fn;
}

/** Register the read-only preview document provider. Call once from activate(). */
export function registerDiffPreviewProvider(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
            onDidChange: previewChangeEmitter.event,
            provideTextDocumentContent: uri => previews.get(uri.toString()) ?? ''
        })
    );
}

/**
 * Show a preview diff and prompt the user to accept or reject the proposed edits.
 * If accepted (and the file did not change while the user reviewed), the edits
 * are applied to the original file and saved.
 */
export async function showPreviewAndConfirm(
    filePath: string,
    changes: ProposedChange[]
): Promise<ConfirmResult> {
    const document = await vscode.workspace.openTextDocument(filePath);
    const versionAtPreview = document.version;

    // Keep the original path (and thus file extension) so the preview gets
    // proper syntax highlighting.
    const previewUri = document.uri.with({ scheme: PREVIEW_SCHEME });
    previews.set(previewUri.toString(), applyToText(document, changes));
    previewChangeEmitter.fire(previewUri);

    try {
        if (confirmOverride) {
            const accepted = await confirmOverride(filePath, changes);
            return accepted
                ? await applyIfUnchanged(document, versionAtPreview, changes)
                : { accepted: false };
        }

        await vscode.commands.executeCommand(
            'vscode.diff',
            document.uri,
            previewUri,
            `${vscode.workspace.asRelativePath(filePath)} ↔ proposed fix`
        );

        const choice = await vscode.window.showInformationMessage(
            'Apply proposed changes?',
            {
                modal: true,
                detail: `${filePath}\n${changes.length} edit${changes.length === 1 ? '' : 's'}. Review the diff in the editor before deciding.`
            },
            'Apply',
            'Reject'
        );

        // Treat dismissal (Esc / X) the same as Reject.
        if (choice !== 'Apply') {
            return { accepted: false };
        }
        return await applyIfUnchanged(document, versionAtPreview, changes);
    } finally {
        await closePreviewTabs(previewUri);
        previews.delete(previewUri.toString());
    }
}

async function applyIfUnchanged(
    document: vscode.TextDocument,
    versionAtPreview: number,
    changes: ProposedChange[]
): Promise<ConfirmResult> {
    if (document.version !== versionAtPreview) {
        return {
            accepted: false,
            note: 'The file changed while the fix was under review; nothing was applied. Re-read the file and propose again.'
        };
    }
    const edit = new vscode.WorkspaceEdit();
    for (const ch of changes) {
        edit.replace(document.uri, ch.range, ch.newText);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
        return { accepted: false, note: 'VS Code rejected the edit (workspace.applyEdit returned false).' };
    }
    await document.save();
    return { accepted: true };
}

/** Compute the post-edit text (edits applied back-to-front so offsets stay valid). */
function applyToText(document: vscode.TextDocument, changes: ProposedChange[]): string {
    const edits = [...changes].sort(
        (a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start)
    );
    let text = document.getText();
    for (const ch of edits) {
        const start = document.offsetAt(ch.range.start);
        const end = document.offsetAt(ch.range.end);
        text = text.slice(0, start) + ch.newText + text.slice(end);
    }
    return text;
}

async function closePreviewTabs(previewUri: vscode.Uri): Promise<void> {
    const key = previewUri.toString();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === key) {
                try {
                    await vscode.window.tabGroups.close(tab);
                } catch {
                    // Closing the preview is best-effort cleanup.
                }
            }
        }
    }
}
