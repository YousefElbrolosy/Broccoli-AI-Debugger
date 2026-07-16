# 🥦 Broccoli — AI Debugger for VS Code

Broccoli turns "the agent reads a stack trace and guesses" into **"the agent drives the real debugger"**: it sets breakpoints, steps, inspects live variables over the Debug Adapter Protocol, and proposes a fix you approve in a diff — never applied silently.

Two ways to use it:

1. **Built-in agent** — bring your own API key (Anthropic, OpenAI, Groq, DeepSeek, Together, xAI, Ollama, or any OpenAI-compatible endpoint) and debug from the sidebar.
2. **MCP server** — expose the same debugger tools over a localhost Model Context Protocol endpoint so external agents like **Claude Code** or **Cursor** can debug through your editor.

## Quick start (built-in agent)

1. Open the **Broccoli** icon in the activity bar.
2. Click **configure** and pick a provider + model (the key is stored in VS Code's SecretStorage, never on disk).
3. Make sure your workspace has a `launch.json` debug configuration.
4. Describe the bug in the panel and hit **Debug it**.

You'll see the agent's activity live: every tool call as a trace line, its reasoning as cards, and token usage at the bottom. Any code change opens a diff with a modal **Apply / Reject** — nothing is written without you.

## MCP server (for Claude Code, Cursor, …)

Run **"Broccoli: Start MCP Server"** from the command palette (or set `broccoli.mcp.autoStart`). Then register it with your agent:

```bash
# Claude Code
claude mcp add --transport http broccoli http://127.0.0.1:4923/mcp
```

```jsonc
// Cursor (~/.cursor/mcp.json)
{
  "mcpServers": {
    "broccoli": { "url": "http://127.0.0.1:4923/mcp" }
  }
}
```

The agent gets 16 tools: session lifecycle (`start_debug_session` by launch-config name, restart, stop), breakpoints (incl. conditional), stepping (`continue_execution`, `step_over/into/out` — each blocks until the next stop and returns the stop reason, top frame and a locals preview), inspection (`get_stack_trace`, `inspect_variables`, `expand_variable`), `read_source`, `get_debugger_state` for cheap orientation, and `propose_code_fix` — which still shows **you** the modal diff.

Settings:

| Setting | Default | Purpose |
|---|---|---|
| `broccoli.mcp.port` | `4923` | Localhost port (server binds `127.0.0.1` only) |
| `broccoli.mcp.authToken` | *(empty)* | Optional `Authorization: Bearer` token |
| `broccoli.mcp.autoStart` | `false` | Start with the extension |
| `broccoli.agent.maxTurns` | `25` | Turn cap per built-in agent run |
| `broccoli.agent.tokenBudget` | `200000` | Token cap per run (0 = off) |

## Safety model

These are properties of the implementation, not the prompt:

- **No expression evaluation** — the agent cannot run code in the debuggee.
- **No silent edits** — every change goes through a modal diff; line numbers are validated against the real file first; if the file changed while you reviewed, the apply is auto-rejected.
- **Workspace-scoped reads** — `read_source` and `propose_code_fix` refuse paths outside open workspace folders.
- **Validated input** — every tool call (internal or MCP) is checked against its JSON Schema before touching the debugger.
- **Bounded runs** — turn cap, token budget, cancellation, and per-request timeouts.
- **Localhost-only MCP** — bound to `127.0.0.1`, optional bearer auth, DNS-rebinding protection.

## Development

```bash
npm install
npm run compile     # typecheck + esbuild bundle
npm test            # unit + integration (real js-debug sessions against test-fixtures/)
```

`test-fixtures/` contains small buggy Node programs (off-by-one, wrong accumulator, async race, uncaught throw) used by the integration tests — and handy for trying the agent yourself: open `test-fixtures/` as a workspace and ask Broccoli why `sum` is `NaN`.

See [architecture.md](architecture.md) for the full design.
