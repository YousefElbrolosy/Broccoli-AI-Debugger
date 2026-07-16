import * as vscode from 'vscode';
import { runAgent } from '../agent/agentLoop';
import { configureProvider, getProviderConfig } from '../agent/secrets';
import type { DebugSessionController } from '../session/DebugSessionController';
import type { AgentState } from '../agent/AgentState';
import type { DebugTools } from '../agent/DebugTools';

interface DebugContext {
    errorMessage: string;
    filePath: string;
    lineNumber?: number;
    codeSnippet?: string;
}

/** The single in-flight agent run, if any. Enforces one run at a time. */
let activeRun: { cts: vscode.CancellationTokenSource } | undefined;
let outputChannel: vscode.OutputChannel | undefined;

export function isAgentRunning(): boolean {
    return activeRun !== undefined;
}

/** Cancel the in-flight run. Returns false when no agent is running. */
export function cancelActiveAgent(): boolean {
    if (!activeRun) {
        return false;
    }
    activeRun.cts.cancel();
    return true;
}

export async function startDebugAgent(
    extContext: vscode.ExtensionContext,
    controller: DebugSessionController,
    state: AgentState,
    debugTools?: DebugTools,
    /** Bug description supplied by the sidebar chat input; skips the InputBox. */
    presetDescription?: string
): Promise<void> {
    if (activeRun) {
        vscode.window.showWarningMessage(
            'A Broccoli agent run is already in progress. Cancel it before starting another.'
        );
        return;
    }

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

    const debugContext = await collectContext(presetDescription);
    if (!debugContext) { return; }

    state.clearNarrative();

    outputChannel ??= vscode.window.createOutputChannel('Broccoli Debug Agent');
    const output = outputChannel;
    output.show(true);

    const initialMessage = buildInitialMessage(debugContext);

    const cts = new vscode.CancellationTokenSource();
    activeRun = { cts };

    try {
        const result = await runAgent({
            config,
            controller,
            initialUserMessage: initialMessage,
            output,
            cancel: cts.token,
            state,
            debugTools
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
        activeRun = undefined;
        cts.dispose();
        const session = controller.session;
        if (session) {
            try {
                await vscode.debug.stopDebugging(session);
                output.appendLine('Stopped debug session.');
            } catch (e) {
                output.appendLine(
                    `Could not stop debug session cleanly: ${e instanceof Error ? e.message : String(e)}`
                );
            }
        }
    }
}

async function collectContext(presetDescription?: string): Promise<DebugContext | undefined> {
    const errorMessage =
        presetDescription?.trim() ||
        (await vscode.window.showInputBox({
            prompt: 'Describe the bug or paste the error',
            placeHolder: "e.g. TypeError: Cannot read property 'x' of undefined",
            ignoreFocusOut: true
        }));
    if (!errorMessage) { return undefined; }

    // Attach context from the active editor when there is one; the agent can
    // always read_source its way to the code otherwise.
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        if (!presetDescription) {
            vscode.window.showErrorMessage('Open the file containing the suspected bug first.');
            return undefined;
        }
        return { errorMessage, filePath: '' };
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
    const parts = [`Bug report: ${ctx.errorMessage}`];
    if (ctx.filePath) {
        parts.push(`File: ${ctx.filePath}${ctx.lineNumber ? `:${ctx.lineNumber}` : ''}`);
    }
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
