import * as vscode from 'vscode';
import {
    addBreakpoint,
    continueExecution,
    getVariablesForFrame,
    listBreakpoints,
    removeBreakpoint,
    restartDebugger,
    startDebugger,
    stepInto,
    stepOut,
    stepOver,
    stopDebugger
} from './command-interface';
import { DebugSessionController } from './session/DebugSessionController';
import { cancelActiveAgent, startDebugAgent } from './orchestrator/debug-agent';
import { registerDiffPreviewProvider } from './orchestrator/diff';
import { clearProviderConfig, configureProvider } from './agent/secrets';
import { AgentState } from './agent/AgentState';
import { DebugTools } from './agent/DebugTools';
import { McpDebugServer } from './mcp/server';
import { SidebarProvider } from './gui/SidebarProvider';

let controller: DebugSessionController | undefined;
let agentState: AgentState | undefined;
let mcpServer: McpDebugServer | undefined;

export function activate(context: vscode.ExtensionContext) {
    controller = new DebugSessionController();
    agentState = new AgentState();
    context.subscriptions.push(controller, agentState);

    // One DebugTools shared by the built-in agent and the MCP server — its
    // internal mutex serializes debugger operations across both surfaces.
    const debugTools = new DebugTools(controller);
    const mcpOutput = vscode.window.createOutputChannel('Broccoli MCP');
    mcpServer = new McpDebugServer(debugTools, agentState, mcpOutput);
    context.subscriptions.push(mcpServer, mcpOutput);

    const sidebar = new SidebarProvider(context, agentState, text => {
        void startDebugAgent(context, controller!, agentState!, debugTools, text).catch(e => {
            vscode.window.showErrorMessage(
                `project-broccoli: ${e instanceof Error ? e.message : String(e)}`
            );
        });
    });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar)
    );
    registerDiffPreviewProvider(context);

    const cmd = (id: string, fn: (...a: any[]) => any) =>
        context.subscriptions.push(
            vscode.commands.registerCommand(id, async (...args: any[]) => {
                try {
                    await fn(...args);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`project-broccoli: ${msg}`);
                }
            })
        );

    // Manual debug commands (operate on the active session; surface errors as toasts).
    cmd('project-broccoli.startDebugger', () => startDebugger());
    cmd('project-broccoli.continueExecution', () => continueExecution());
    cmd('project-broccoli.stepOver', () => stepOver());
    cmd('project-broccoli.stepInto', () => stepInto());
    cmd('project-broccoli.stepOut', () => stepOut());
    cmd('project-broccoli.restartDebugger', () => restartDebugger());
    cmd('project-broccoli.stopDebugger', () => stopDebugger());

    cmd('project-broccoli.inspectVariables', async () => {
        const vars = await getVariablesForFrame();
        const ch = vscode.window.createOutputChannel('Broccoli: Variables');
        ch.show(true);
        ch.appendLine(JSON.stringify(vars, null, 2));
    });

    cmd('project-broccoli.addBreakpointAtCursor', async () => {
        const e = vscode.window.activeTextEditor;
        if (!e) { throw new Error('No active editor'); }
        await addBreakpoint(e.document.uri.fsPath, e.selection.active.line + 1);
    });

    cmd('project-broccoli.removeBreakpointAtCursor', async () => {
        const e = vscode.window.activeTextEditor;
        if (!e) { throw new Error('No active editor'); }
        const removed = await removeBreakpoint(e.document.uri.fsPath, e.selection.active.line + 1);
        if (!removed) {
            vscode.window.showInformationMessage('No breakpoint at cursor.');
        }
    });

    cmd('project-broccoli.listBreakpoints', () => {
        const ch = vscode.window.createOutputChannel('Broccoli: Breakpoints');
        ch.show(true);
        ch.appendLine(JSON.stringify(listBreakpoints(), null, 2));
    });

    // Agent commands.
    cmd('project-broccoli.startDebugAgent', () =>
        startDebugAgent(context, controller!, agentState!, debugTools)
    );
    cmd('project-broccoli.cancelAgent', () => {
        if (!cancelActiveAgent()) {
            vscode.window.showInformationMessage('No Broccoli agent is running.');
        }
    });
    cmd('project-broccoli.configureProvider', () => configureProvider(context));
    cmd('project-broccoli.clearProviderConfig', () => clearProviderConfig(context));

    // MCP server commands.
    cmd('project-broccoli.startMcpServer', async () => {
        await mcpServer!.start(mcpOptions());
        vscode.window.showInformationMessage(
            `Broccoli MCP server listening on http://127.0.0.1:${mcpOptions().port}/mcp`
        );
    });
    cmd('project-broccoli.stopMcpServer', () => mcpServer!.stop());

    if (vscode.workspace.getConfiguration('broccoli.mcp').get<boolean>('autoStart', false)) {
        mcpServer.start(mcpOptions()).catch(e => {
            vscode.window.showErrorMessage(
                `Broccoli MCP server failed to start: ${e instanceof Error ? e.message : String(e)}`
            );
        });
    }
}

function mcpOptions() {
    const cfg = vscode.workspace.getConfiguration('broccoli.mcp');
    return {
        port: cfg.get<number>('port', 4923),
        authToken: cfg.get<string>('authToken', '')
    };
}

export function deactivate() {
    controller?.dispose();
    controller = undefined;
    agentState?.dispose();
    agentState = undefined;
    mcpServer?.dispose();
    mcpServer = undefined;
}
