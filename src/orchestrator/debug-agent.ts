import * as vscode from 'vscode';
import { runAgent } from '../agent/AnthropicAgent';
import { configureProvider, getProviderConfig } from '../agent/secrets';
import type { DebugSessionController } from '../session/DebugSessionController';
import { stopDebugger } from '../command-interface';
import type { AgentState } from '../agent/AgentState';

interface DebugContext {
    errorMessage: string;
    filePath: string;
    lineNumber?: number;
    codeSnippet?: string;
}

export async function startDebugAgent(
    extContext: vscode.ExtensionContext,
    controller: DebugSessionController,
    state: AgentState
): Promise<void> {
    let config = await getProviderConfig(extContext);
    if (!config) {
        const choice = await vscode.window.showInformationMessage(
            'No LLM provider configured. Set one up now?',
            'Configure',
            'Cancel'
        );
        if (choice !== 'Configure') { return; }
        const fresh = await configureProvider(extContext);
        if (!fresh) { return; }
        config = fresh;
    }

    const debugContext = await collectContext();
    if (!debugContext) { return; }

    state.clearNarrative();

    const output = vscode.window.createOutputChannel('Broccoli Debug Agent');
    output.show(true);

    const initialMessage = buildInitialMessage(debugContext);

    const cts = new vscode.CancellationTokenSource();
    const cancelDisposable = vscode.commands.registerCommand(
        'project-broccoli.cancelAgent',
        () => cts.cancel()
    );

    try {
        const result = await runAgent({
            config,
            controller,
            initialUserMessage: initialMessage,
            output,
            cancel: cts.token,
            state
        });
        output.appendLine(
            `\n=== Agent done — turns=${result.turns}, finished=${result.finished} ===`
        );
        if (result.summary) {
            output.appendLine(`Summary: ${result.summary}`);
        }
        state.set({
            kind: 'done',
            finished: result.finished,
            turns: result.turns,
            summary: result.summary
        });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        output.appendLine(`\n=== Fatal: ${msg} ===`);
        vscode.window.showErrorMessage(`Debug agent error: ${msg}`);
        state.append({ kind: 'error', text: msg, turn: 0 });
        state.set({ kind: 'done', finished: false, turns: 0, summary: msg });
    } finally {
        cancelDisposable.dispose();
        cts.dispose();
        if (controller.session) {
            try {
                stopDebugger();
                output.appendLine('Stopped debug session.');
            } catch (e) {
                output.appendLine(
                    `Could not stop debug session cleanly: ${e instanceof Error ? e.message : String(e)}`
                );
            }
        }
    }
}

async function collectContext(): Promise<DebugContext | undefined> {
    const errorMessage = await vscode.window.showInputBox({
        prompt: 'Describe the bug or paste the error',
        placeHolder: "e.g. TypeError: Cannot read property 'x' of undefined",
        ignoreFocusOut: true
    });
    if (!errorMessage) { return undefined; }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Open the file containing the suspected bug first.');
        return undefined;
    }
    const filePath = editor.document.uri.fsPath;
    const lineNumber = editor.selection.active.line + 1;
    const start = Math.max(0, lineNumber - 6);
    const end = Math.min(editor.document.lineCount, lineNumber + 10);
    const codeSnippet = editor.document.getText(
        new vscode.Range(start, 0, end, 0)
    );
    return { errorMessage, filePath, lineNumber, codeSnippet };
}

function buildInitialMessage(ctx: DebugContext): string {
    const parts = [
        `Bug report: ${ctx.errorMessage}`,
        `File: ${ctx.filePath}${ctx.lineNumber ? `:${ctx.lineNumber}` : ''}`
    ];
    if (ctx.codeSnippet) {
        parts.push('Code context (around the cursor):');
        parts.push('```');
        parts.push(ctx.codeSnippet);
        parts.push('```');
    }
    parts.push(
        'Drive the debugger using the available tools. Call finish when you have proposed a fix or cannot make further progress.'
    );
    return parts.join('\n');
}
