import * as vscode from 'vscode';
import { getProviderConfig } from '../agent/secrets';
import type {
    AgentState,
    AgentRunStatus,
    McpStatus,
    NarrativeEntry,
    ToolEvent,
    UsageTotals
} from '../agent/AgentState';

interface PostState {
    type: 'state';
    provider: string | null;
    agent: AgentRunStatus;
    narrative: NarrativeEntry[];
    toolEvents: ToolEvent[];
    usage: UsageTotals;
    mcp: McpStatus;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'project-broccoli-view';
    private view?: vscode.WebviewView;

    constructor(
        private readonly extContext: vscode.ExtensionContext,
        private readonly state: AgentState,
        /** Invoked when the user submits a bug description from the panel. */
        private readonly onStartAgent: (text: string) => void
    ) {
        extContext.subscriptions.push(state.onChange(() => this.postState()));
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extContext.extensionUri]
        };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage(async msg => {
            if (msg?.type === 'cmd' && typeof msg.id === 'string') {
                await vscode.commands.executeCommand(msg.id);
            } else if (msg?.type === 'startAgent' && typeof msg.text === 'string') {
                this.onStartAgent(msg.text);
            } else if (msg?.type === 'refresh') {
                await this.postState();
            }
        });
        void this.postState();
    }

    private async postState(): Promise<void> {
        if (!this.view) { return; }
        const cfg = await getProviderConfig(this.extContext);
        const providerLabel = cfg
            ? `${cfg.displayName ?? cfg.provider} · ${cfg.model}`
            : null;
        const payload: PostState = {
            type: 'state',
            provider: providerLabel,
            agent: this.state.status,
            narrative: [...this.state.narrative],
            toolEvents: [...this.state.toolEvents],
            usage: this.state.usage,
            mcp: this.state.mcp
        };
        this.view.webview.postMessage(payload);
    }

    private html(webview: vscode.Webview): string {
        const nonce = getNonce();
        const uri = (...segments: string[]) =>
            webview.asWebviewUri(
                vscode.Uri.joinPath(this.extContext.extensionUri, ...segments)
            );
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${uri('media', 'sidebar.css')}" />
</head>
<body>
  <header>
    <div class="brand-row">
      <span class="wordmark"><span class="leaf">●</span>Broccoli</span>
      <button class="mcp-chip" id="mcp-chip" aria-label="Toggle MCP server">
        <span class="dot"></span><span id="mcp-label">mcp off</span>
      </button>
    </div>
    <div class="provider-row">
      <span class="provider-label" id="provider-label">no model configured</span>
      <button class="link-btn" id="btn-configure">configure</button>
    </div>
  </header>

  <div class="composer">
    <textarea id="bug-input" rows="3"
      placeholder="What's broken? Paste an error or describe the bug…"></textarea>
    <div class="actions">
      <button class="btn" id="btn-go">Debug it</button>
      <button class="btn stop" id="btn-stop" style="display:none">Stop</button>
    </div>
    <div class="hint">Runs the debugger with breakpoints and live inspection. Code changes always wait for your approval.</div>
  </div>

  <div class="status-row">
    <span class="dot" id="status-dot"></span>
    <span id="status-text">idle</span>
  </div>

  <div class="feed" id="feed"></div>

  <div class="stats">
    <div class="nums">
      <span id="stat-in">in 0</span>
      <span id="stat-out">out 0</span>
      <span id="stat-cache">cache 0%</span>
    </div>
    <div class="budget" id="budget"><div class="fill" id="budget-fill"></div></div>
  </div>

  <script nonce="${nonce}" src="${uri('media', 'sidebar.js')}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}
