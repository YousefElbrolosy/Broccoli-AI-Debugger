// Webview script for the Broccoli sidebar. Receives {type:'state', ...}
// payloads from the extension and posts {startAgent|cmd|refresh} back.
(function () {
    const vscode = acquireVsCodeApi();

    const el = id => document.getElementById(id);
    const input = el('bug-input');
    const goBtn = el('btn-go');
    const stopBtn = el('btn-stop');

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function fmtTokens(n) {
        if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
        if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'k'; }
        return String(n);
    }

    function fmtMs(ms) {
        if (ms === undefined) { return ''; }
        return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
    }

    // --- outbound ---

    el('btn-configure').addEventListener('click', () =>
        vscode.postMessage({ type: 'cmd', id: 'project-broccoli.configureProvider' }));

    stopBtn.addEventListener('click', () =>
        vscode.postMessage({ type: 'cmd', id: 'project-broccoli.cancelAgent' }));

    let mcpRunning = false;
    el('mcp-chip').addEventListener('click', () =>
        vscode.postMessage({
            type: 'cmd',
            id: mcpRunning ? 'project-broccoli.stopMcpServer' : 'project-broccoli.startMcpServer'
        }));

    function submit() {
        const text = input.value.trim();
        if (!text || goBtn.disabled) { return; }
        vscode.postMessage({ type: 'startAgent', text });
        input.value = '';
    }
    goBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    });

    // --- rendering ---

    const GLYPH = { ok: '✓', error: '✕', running: '◌' };
    const TAG = { thought: 'thought', rationale: 'fix rationale', summary: 'summary', error: 'error' };

    function renderFeed(narrative, toolEvents) {
        const feed = el('feed');
        const events = []
            .concat((narrative || []).map(n => ({ ...n, _type: 'card', seq: n.seq || 0 })))
            .concat((toolEvents || []).map(t => ({ ...t, _type: 'tool' })))
            .sort((a, b) => a.seq - b.seq);

        if (events.length === 0) {
            feed.innerHTML =
                '<div class="empty-state">Describe a bug above and Broccoli will drive the debugger: ' +
                'breakpoints, stepping, variable inspection — then propose a fix you approve.</div>';
            return;
        }

        const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
        let html = '<div class="rail">';
        let lastTurn = 0;
        for (const e of events) {
            if (e.turn && e.turn !== lastTurn) {
                lastTurn = e.turn;
                html += '<div class="turn-mark">turn ' + e.turn + '</div>';
            }
            if (e._type === 'tool') {
                html +=
                    '<div class="tool-line ' + esc(e.status) + '">' +
                    '<span class="glyph">' + (GLYPH[e.status] || '·') + '</span>' +
                    '<span class="name">' + esc(e.name) + '</span>' +
                    '<span class="args">' + esc(e.argsSummary || '') + '</span>' +
                    '<span class="ms">' + fmtMs(e.ms) + '</span>' +
                    '</div>';
            } else {
                html +=
                    '<div class="card ' + esc(e.kind) + '">' +
                    '<span class="tag">' + esc(TAG[e.kind] || e.kind) + '</span>' +
                    esc(e.text) +
                    '</div>';
            }
        }
        html += '</div>';
        feed.innerHTML = html;
        if (stick) { feed.scrollTop = feed.scrollHeight; }
    }

    function renderStatus(agent) {
        const dot = el('status-dot');
        const text = el('status-text');
        const running = agent.kind === 'running';

        dot.className = 'dot';
        if (agent.kind === 'idle') {
            text.textContent = 'idle';
        } else if (running) {
            dot.classList.add('run');
            text.textContent =
                'running · turn ' + agent.turn + '/' + agent.maxTurns +
                (agent.toolName ? ' · ' + agent.toolName : '');
        } else {
            dot.classList.add(agent.finished ? 'ok' : 'fail');
            text.textContent = (agent.finished ? 'finished' : 'stopped') + ' · ' + agent.turns + ' turns';
        }

        input.disabled = running;
        goBtn.disabled = running;
        goBtn.style.display = running ? 'none' : '';
        stopBtn.style.display = running ? '' : 'none';
    }

    function renderStats(usage) {
        const u = usage || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, tokenBudget: 0 };
        const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + (u.cacheWriteTokens || 0);
        const denom = u.inputTokens + u.cacheReadTokens;
        const cachePct = denom > 0 ? Math.round((u.cacheReadTokens / denom) * 100) : 0;
        el('stat-in').textContent = 'in ' + fmtTokens(u.inputTokens);
        el('stat-out').textContent = 'out ' + fmtTokens(u.outputTokens);
        el('stat-cache').textContent = 'cache ' + cachePct + '%';

        const budget = el('budget');
        const fill = el('budget-fill');
        if (u.tokenBudget > 0) {
            budget.classList.add('visible');
            budget.title = fmtTokens(total) + ' of ' + fmtTokens(u.tokenBudget) + ' token budget';
            const pct = Math.min(100, (total / u.tokenBudget) * 100);
            fill.style.width = pct + '%';
            fill.className = 'fill' + (pct > 90 ? ' hot' : pct > 70 ? ' warn' : '');
        } else {
            budget.classList.remove('visible');
        }
    }

    function renderMcp(mcp) {
        mcpRunning = !!(mcp && mcp.running);
        const chip = el('mcp-chip');
        chip.classList.toggle('up', mcpRunning);
        el('mcp-label').textContent = mcpRunning ? 'mcp :' + mcp.port : 'mcp off';
        chip.title = mcpRunning
            ? 'MCP server on http://127.0.0.1:' + mcp.port + '/mcp · ' +
              (mcp.requestCount || 0) + ' requests · click to stop'
            : 'Start the MCP server so external agents (Claude Code, Cursor) can drive this debugger';
    }

    window.addEventListener('message', e => {
        const m = e.data;
        if (!m || m.type !== 'state') { return; }

        const prov = el('provider-label');
        if (m.provider) {
            prov.textContent = m.provider;
            prov.classList.add('configured');
        } else {
            prov.textContent = 'no model configured';
            prov.classList.remove('configured');
        }

        renderMcp(m.mcp);
        renderStatus(m.agent);
        renderFeed(m.narrative, m.toolEvents);
        renderStats(m.usage);
    });

    vscode.postMessage({ type: 'refresh' });
})();
