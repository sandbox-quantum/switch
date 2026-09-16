# @switch-console/agent-providers

Provider adapters that drive coding agents over their native SDKs and
protocols instead of typing into a TUI in tmux.

## Shape

- `src/adapter.ts` — the `ProviderAdapter` interface every provider implements.
  One adapter instance drives many sessions, keyed by Switch's session id.
- `src/events.ts` — the normalized `ProviderRuntimeEvent` stream. Orchestration,
  status derivation and the transcript UI consume only this; vendor payloads
  ride along in `raw` for debugging.
- `src/testing/` — the conformance suite (`describeConformance`) that every
  adapter runs against the real provider, plus `EventRecorder`.
- `src/<provider>/` — one directory per provider.

## Transports (decided, do not relitigate per adapter)

| Provider | Transport | Why |
|---|---|---|
| `opencode` | `opencode serve` spawned per session, driven with `@opencode-ai/sdk` over HTTP + SSE | Sessions are server-side; permissions and questions are answerable over the API. One server per session because OpenCode stores MCP registrations per directory and Switch registers an MCP server per session. |
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode, one long-lived query per session | Mid-turn messages queue into the live loop; `canUseTool` carries both approvals and `AskUserQuestion`; sessions share the CLI's transcript files so `--resume` interoperates. |
| `codex` | `codex app-server` JSON-RPC over stdio | The Codex SDK wraps `codex exec`, which cannot answer approvals. app-server can, and supports `turn/steer`, `thread/resume` and `turn/interrupt`. |
| `antigravity` | `agy --input-format stream-json --output-format stream-json` over stdio | The only non-interactive surface the CLI has. The process stays alive between turns, so one NDJSON line per turn keeps the conversation, and `--conversation <id>` resumes it after the process goes away. |

## Rules for an adapter

- Map the vendor's permission model onto `RuntimeMode` inside the adapter.
  `full-access` must never surface a `request.opened` for ordinary work.
- Emit `turn.started` and exactly one `turn.completed` per turn id the caller
  passed in. A steered message reuses the running turn and reports it in
  `steeredInto`.
- Every `request.opened` and `user-input.requested` must be answerable through
  the adapter until the session stops; auto-resolve them with `cancel` on stop.
- Spawned processes get exactly `input.env`; do not merge `process.env`.
- Throw `ProviderSessionError` for a dead or unknown session, never return a
  boolean. Emit `session.exited` when the vendor process or server goes away.
- Log at warning for degraded-but-working, and emit `runtime.warning` so the
  UI can show it.

## Running the conformance suite

```bash
cd console/packages/agent-providers
pnpm test:integration                                   # all providers, sequential
pnpm exec vitest run src/opencode/opencode.integration.test.ts   # one provider
```

The suite skips itself when the provider binary or login is missing and says
why. It spends real tokens. Passing a path after `pnpm test:integration --`
does not filter; use `pnpm exec vitest run <file>` for one provider.

## Known provider limits (verified 2026-09-05)

| Provider | Version | Conformance | Limit |
|---|---|---|---|
| opencode | 1.18.27 | 10/10 | Auto-answers doom-loop and subagent asks in `full-access` with `once`, never `always` (OpenCode remembers `always` per directory). Config isolation only via `XDG_CONFIG_HOME`. |
| claude | 2.1.260 | 10/10 | `AskUserQuestion` is offered to a session **only while a `canUseTool` callback is registered** — in `default` and `bypassPermissions` alike — so the adapter registers one in every mode and filters the SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning rather than obeying it. A mid-turn message is queued after the running turn, not folded into it; the adapter keeps the turn open until every queued send is answered. |
| codex | 0.153.2 | 9/10 | `request_user_input` only works in Plan mode, so `user-input` is skipped. Subagents need `--enable multi_agent_v2`. `turn/steer` joins the running turn. |
| antigravity | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. |

## Cursor CLI

The local Cursor adapter uses `agent acp` with the installed CLI's existing login.
It registers session-scoped MCP servers, queues follow-up turns, supports native
resume and model selection, and translates tool, question and plan decisions to
Console events. Only caller-registered MCP tools bypass interactive decisions;
ordinary approvals select allow-once and never persist allow-always policies.
Cursor's question/plan extension methods are handled (including the ACP `_` wire
prefix). The installed CLI/default model used for verification did not expose its
AskQuestion tool, so real conversation questions use prose; protocol answer and
plan approval payloads are tested separately. Subagent lifecycle is verified.

Cursor is Console-managed and local-only; there is no separate connector install.
Create-agent and provider settings expose it when `agent` is installed.

## Antigravity CLI

The local Antigravity adapter drives `agy` in stream-json print mode with the
installed CLI's existing login. `HOME` cannot be redirected — the credential
lives in the macOS keychain keyed outside the CLI's own directories — so the
session runs against the user's real Antigravity configuration and the adapter
has to reach into it rather than build an isolated copy.

**MCP servers** go into `<cwd>/.agents/mcp_config.json`, the workspace
customization root the CLI walks up from the working directory. That is the only
location scoped to a single session's directory that keeps the caller's server
names: a `plugins/<name>/mcp_config.json` also works but the CLI renames every
server it finds there to `<plugin>_<server>`, and `~/.gemini/config/mcp_config.json`
is machine-wide. The adapter merges into whatever the file already had and puts
the original bytes back on stop. Two sessions sharing one working directory
therefore share the file; the last writer wins for a name they both use.

**Permissions** are the reason the adapter also touches
`~/.gemini/antigravity-cli/settings.json`, the one file whose `permissions.allow`
the CLI honours (a workspace `.agents/settings.json` is not read for this). In
the modes that do not pass `--dangerously-skip-permissions`, the caller's own MCP
servers are allow-listed there as `mcp(<name>/*)` so the session can reach the
room protocol it was started for, and nothing else is. The rules are refcounted
across the adapter's live sessions and removed when the last one stops.

**Attachments** are named by path in the turn text; the CLI reads them with its
own file tools rather than receiving bytes.
