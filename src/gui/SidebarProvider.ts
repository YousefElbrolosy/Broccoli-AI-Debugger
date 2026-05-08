import * as vscode from 'vscode';
import { getProviderConfig } from '../agent/secrets';
import type { AgentState, AgentRunStatus, NarrativeEntry } from '../agent/AgentState';

interface PostState {
    type: 'state';
    provider: string | null;
    agent: AgentRunStatus;
    narrative: NarrativeEntry[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'project-broccoli-view';
    private view?: vscode.WebviewView;

    constructor(
        private readonly extContext: vscode.ExtensionContext,
        private readonly state: AgentState
    ) {
        extContext.subscriptions.push(state.onChange(() => this.postState()));
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage(async msg => {
            if (msg?.type === 'cmd' && typeof msg.id === 'string') {
                await vscode.commands.executeCommand(msg.id);
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
            narrative: [...this.state.narrative]
        };
        this.view.webview.postMessage(payload);
    }

    private html(): string {
        const csp = [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "script-src 'unsafe-inline'"
        ].join('; ');

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 12px 12px 16px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 6px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  .section + .section {
    padding-top: 14px;
    border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
  }
  button {
    width: 100%;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 6px 10px;
    margin: 4px 0 0;
    cursor: pointer;
    border-radius: 2px;
    font-family: inherit;
    font-size: 12px;
    text-align: left;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-inputValidation-errorForeground, #fff);
    border-color: var(--vscode-inputValidation-errorBorder, transparent);
  }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 9px;
    font-size: 11px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .pill.running {
    background: var(--vscode-statusBarItem-warningBackground, #b89200);
    color: var(--vscode-statusBarItem-warningForeground, #1f1f1f);
  }
  .pill.ok {
    background: var(--vscode-testing-iconPassed, #1f8c3a);
    color: #fff;
  }
  .pill.fail {
    background: var(--vscode-errorForeground, #c0392b);
    color: #fff;
  }
  .provider {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    margin: 4px 0 6px;
    word-break: break-all;
  }
  .provider.empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }

  /* Narrative log */
  #narrative-section { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #narrative {
    flex: 1;
    min-height: 80px;
    overflow-y: auto;
    margin-top: 6px;
    padding-right: 4px;
  }
  .entry {
    padding: 8px 10px;
    margin-bottom: 6px;
    border-radius: 3px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
    border-left: 3px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.4));
    background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.08));
  }
  .entry .tag {
    display: inline-block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-right: 6px;
    font-weight: 600;
  }
  .entry .turn {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    float: right;
  }
  .entry.thought { border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
  .entry.rationale { border-left-color: var(--vscode-symbolIcon-classForeground, #ee9d28); }
  .entry.summary {
    border-left-color: var(--vscode-testing-iconPassed, #1f8c3a);
    background: var(--vscode-diffEditor-insertedTextBackground, rgba(31, 140, 58, 0.10));
  }
  .entry.error {
    border-left-color: var(--vscode-errorForeground, #c0392b);
    background: var(--vscode-inputValidation-errorBackground, rgba(192, 57, 43, 0.10));
  }
  .empty-state {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 12px;
    padding: 8px 0;
  }
</style>
</head>
<body>
  <div class="section">
    <h2>Provider</h2>
    <div id="provider-line" class="provider empty">—</div>
    <button class="secondary" data-cmd="project-broccoli.configureProvider">Configure provider…</button>
  </div>

  <div class="section">
    <h2>AI debug agent</h2>
    <div><span class="pill" id="status-pill">idle</span></div>
    <button id="btn-start" data-cmd="project-broccoli.startDebugAgent">▶ Start AI debug agent</button>
    <button id="btn-cancel" class="danger" data-cmd="project-broccoli.cancelAgent" style="display:none">■ Cancel</button>
    <div class="hint">Describe the bug, then watch the model's reasoning below.</div>
  </div>

  <div class="section" id="narrative-section">
    <h2>Reasoning</h2>
    <div id="narrative">
      <div class="empty-state" id="empty-state">No output yet — start the agent to see what it's thinking.</div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();

  document.body.addEventListener('click', e => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    vscode.postMessage({ type: 'cmd', id: btn.dataset.cmd });
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  const TAG_LABELS = {
    thought: 'Thought',
    rationale: 'Fix rationale',
    summary: 'Summary',
    error: 'Error'
  };

  function renderNarrative(entries) {
    const root = document.getElementById('narrative');
    if (!entries || entries.length === 0) {
      root.innerHTML = '<div class="empty-state">No output yet — start the agent to see what it\\'s thinking.</div>';
      return;
    }
    const stickToBottom =
      root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    root.innerHTML = entries.map(e => {
      const label = TAG_LABELS[e.kind] || e.kind;
      const turn = e.turn > 0 ? '<span class="turn">turn ' + e.turn + '</span>' : '';
      return (
        '<div class="entry ' + escapeHtml(e.kind) + '">' +
          turn +
          '<span class="tag">' + escapeHtml(label) + '</span>' +
          escapeHtml(e.text) +
        '</div>'
      );
    }).join('');
    if (stickToBottom) {
      root.scrollTop = root.scrollHeight;
    }
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type !== 'state') return;

    const provLine = document.getElementById('provider-line');
    if (m.provider) {
      provLine.textContent = m.provider;
      provLine.classList.remove('empty');
    } else {
      provLine.textContent = 'Not configured';
      provLine.classList.add('empty');
    }

    const pill = document.getElementById('status-pill');
    const start = document.getElementById('btn-start');
    const cancel = document.getElementById('btn-cancel');
    const a = m.agent;

    pill.className = 'pill';
    start.style.display = '';
    cancel.style.display = 'none';

    if (a.kind === 'idle') {
      pill.textContent = 'idle';
    } else if (a.kind === 'running') {
      pill.classList.add('running');
      const tool = a.toolName ? ' · ' + a.toolName : '';
      pill.textContent = 'running · turn ' + a.turn + '/' + a.maxTurns + tool;
      start.style.display = 'none';
      cancel.style.display = '';
    } else {
      pill.classList.add(a.finished ? 'ok' : 'fail');
      pill.textContent = (a.finished ? 'finished' : 'stopped') + ' · ' + a.turns + ' turns';
    }

    renderNarrative(m.narrative);
  });

  vscode.postMessage({ type: 'refresh' });
</script>
</body>
</html>`;
    }
}
