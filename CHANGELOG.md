# Change Log

All notable changes to the "project-broccoli" extension are documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/).

## [0.1.0] - 2026-08-20

Initial release.

### Added

- **AI debug agent** — describe a bug in the sidebar and the agent drives VS Code's
  real debugger to investigate it: setting breakpoints, stepping, and inspecting
  live variables over the Debug Adapter Protocol.
- **Bring your own key** — Anthropic, OpenAI, Groq, DeepSeek, Together, xAI, Ollama,
  or any OpenAI-compatible endpoint. Keys are stored in VS Code's SecretStorage.
- **MCP server** — exposes the same 16 debugger tools over a localhost Model Context
  Protocol endpoint, so external agents such as Claude Code or Cursor can debug
  through your editor. Off by default; enable with `broccoli.mcp.autoStart` or the
  "Broccoli: Start MCP Server" command.
- **Live agent trace** — tool calls, reasoning, and token usage stream into the sidebar
  as the run progresses.
- **Debugger commands** in the command palette: start/restart/stop, continue, step
  over/into/out, add/remove breakpoint at cursor, list breakpoints, and inspect
  variables.

### Safety

These are properties of the implementation, not of the prompt:

- **No expression evaluation** — the agent cannot execute code in the debuggee.
- **No silent edits** — every proposed change opens a modal diff for approval. Line
  numbers are validated against the real file first, and an apply is auto-rejected if
  the file changed while you were reviewing it.
- **Workspace-scoped reads** — `read_source` and `propose_code_fix` refuse paths
  outside the open workspace folders.
- **Validated input** — every tool call, internal or over MCP, is checked against its
  JSON Schema before it reaches the debugger.
- **Bounded runs** — turn cap (`broccoli.agent.maxTurns`), token budget
  (`broccoli.agent.tokenBudget`), cancellation, and per-request timeouts.
- **Localhost-only MCP** — binds `127.0.0.1` only, with optional bearer auth and
  DNS-rebinding protection.
