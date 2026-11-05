# @switch-console/agent-providers

Provider adapters that drive coding agents over their native SDKs and
protocols. These six providers are the only Console session runtime.

## Shape

- `src/adapter.ts` — the `ProviderAdapter` interface every provider implements.
  One adapter instance drives many sessions, keyed by Switch's session id.
- `src/events.ts` — the normalized `ProviderRuntimeEvent` stream. Orchestration,
  status derivation and the transcript UI consume only this; vendor payloads
  ride along in `raw` for debugging.
- `src/testing/` — the conformance suite (`describeConformance`) that every
  adapter runs against the real provider, plus `EventRecorder`.
- `src/acp/` — the generic Agent Client Protocol adapter every ACP-speaking
  CLI runs on, and the `AcpProviderHooks` a CLI supplies.
- `src/providers/registry.ts` — `PROVIDER_RUNTIMES`, the one list of providers
  the execution host can run: each entry's adapter, sign-in check and login
  command.
- `src/<provider>/` — one directory per provider. For an ACP CLI this is only
  its hooks.

## Transports (decided, do not relitigate per adapter)

| Provider | Transport | Why |
|---|---|---|
| `opencode` | `opencode serve` spawned per session, driven with `@opencode-ai/sdk` over HTTP + SSE | Sessions are server-side; permissions and questions are answerable over the API. One server per session because OpenCode stores MCP registrations per directory and Switch registers an MCP server per session. |
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode, one long-lived query per session | Mid-turn messages queue into the live loop; `canUseTool` carries both approvals and `AskUserQuestion`; sessions share the CLI's transcript files so `--resume` interoperates. |
| `codex` | `codex app-server` JSON-RPC over stdio | The Codex SDK wraps `codex exec`, which cannot answer approvals. app-server can, and supports `turn/steer`, `thread/resume` and `turn/interrupt`. |
| `antigravity` | `antigravity-acp`, ACP over stdio, on the generic ACP adapter | Native sessions, resume, model selection through a `model` config option, MCP registration, approvals and questions. |
| `cursor` | `agent acp`, ACP over stdio, on the generic ACP adapter | Native sessions, model catalogue, MCP registration and approvals, plus Cursor's question, plan, todo and task extensions. |
| `copilot` | `copilot --acp --stdio`, ACP over stdio, on the generic ACP adapter | Native sessions, model selection, MCP registration and Switch permission handling. |
| any new ACP CLI | ACP over stdio, on the generic ACP adapter | Write hooks, not an adapter: see [Add an agent provider](../../docs/add-an-agent-provider.md). |

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
| antigravity (ACP) | antigravity-acp 1.1.1 | 9/10 (2026-10-11) | `subagent` is skipped: `invoke_subagent` runs past the 300 s deadline, on main's adapter as on the generic one. `mcp-registered` passes on the generic adapter and timed out on main's. |
| cursor (ACP) | 2026.10.01 | not recorded | The account used hit Cursor's usage limit, so no model turn ran. Set `CURSOR_API_KEY` in the shell to run the suite with a key; the test passes it through. |
| copilot (ACP) | 1.0.105 | 10 skipped: signed out (2026-11-04) | Live-model conformance needs GitHub credentials with Copilot access or a configured BYOK provider. Structured user input is unsupported by this integration. A separate protocol suite uses the real CLI with mocked local inference; it does not establish live-model conformance. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

## ACP providers

Cursor, Antigravity and Copilot run on one adapter, `src/acp/acp-adapter.ts`, which
covers the protocol and chooses behaviour from what the agent advertises in
`initialize` and `session/new`:

- resume uses `session/load` when the agent advertises `loadSession`, else
  `session/resume` when it advertises `sessionCapabilities.resume`, else asks
  the host for a fresh conversation;
- a `model` select in the session's config options is set with
  `session/set_config_option`; otherwise `session/set_model` is used against
  the session's `models` list;
- attachments go as `image`, `audio` or embedded `resource` blocks only where
  the agent (or its hooks) says it takes them, else as `resource_link`.

Everything else that differs between CLIs is in its hooks file
(`src/cursor/cursor-adapter.ts`, `src/antigravity/antigravity-adapter.ts`):
binary and arguments, the `authenticate` method, the mode for each runtime
mode, how a tool call names its MCP server, sign-in checks, and vendor
extensions.

Permission requests follow one policy for every ACP agent. A tool on an MCP
server the session registered is allowed once without asking, as is
everything in `full-access` and edits in `auto-accept-edits`. Otherwise the
person is offered allow once, allow for this session and reject; options
naming a permanent or future policy are never offered.

**Cursor** extensions: `cursor/ask_question` (several questions, multi-select),
`cursor/create_plan` (an approval with the plan as its detail),
`update_todos`, `task` and `generate_image`, each with and without the ACP `_`
prefix. The CLI and default model used for verification did not expose its
AskQuestion tool, so `user-input` is skipped in its conformance run.

**Antigravity** runs in its own profile directory (`GEMINI_HOME`), set up for
OAuth on first use. Its questions arrive as permission requests whose tool
call id starts with `interaction_`. Native session ids are stored with an
`acp:` prefix; a conversation saved by the retired `agy` runtime starts fresh.
Its sign-in check reads `authMethods` from the handshake and never calls
`authenticate`, which would open a browser.

**Copilot** uses the supported [ACP stdio launch mode](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
Install with `npm install -g @github/copilot`, then run `copilot login` on
the execution machine, or configure the CLI's BYOK environment. Console and
headless hosts pass through the declared Copilot profile, token, GitHub host
and BYOK variables. Readiness opens an empty ACP session, never calls
`authenticate` or sends a prompt, and disposes the process. Copilot may keep
an empty history entry. This checks session access, not inference quota.
The CLI advertises `copilot-login` even when BYOK session access succeeds,
so the handshake alone cannot determine readiness.

Copilot 1.0.105 rejects ACP stdio MCP entries, so its conformance fixture uses
HTTP, the same transport as Switch's room tools. MCP tool-start titles name
the server (`server-tool`), while permission titles contain only the tool.
The hook identifies an unambiguous registered server from the earlier event;
the adapter remembers it for the permission request. Ambiguous or missing
identities still ask, and connector servers retain their approval boundary.

Model choices come from ACP session metadata and are applied through
`session/set_config_option` or `session/set_model`. In the tested BYOK mode
the CLI advertises no model catalogue; its configured
`COPILOT_PROVIDER_MODEL_ID` / `COPILOT_PROVIDER_WIRE_MODEL` selects the model.
GitHub account model selection still needs live account verification.

Switch does not pass `--yolo` or select Copilot's autonomous workflow mode.
It answers ACP permission requests according to the shared policy above.
Although `--yolo` was reported ineffective in earlier ACP versions, the
1.0.105 probe set `allow_all=on` and executed a temporary shell write without
a permission request. With the provider's normal launch the same write
waited for permission; denial prevented it. Full access approved it through
Switch, while edit-only auto approval still required shell approval.

To reproduce these checks without credentials:

```bash
pnpm exec vitest run src/copilot/copilot.protocol.integration.test.ts
```

This separate suite runs the installed Copilot CLI and its real shell tools
against a deterministic local OpenAI-compatible inference server, with an
isolated profile and offline mode. It covers readiness, approvals, tool
activity, registered HTTP MCP calls and connector denial, configured wire model,
auto approval, cancellation, queued turns,
context recovery and permissions after restart, plus the native `--yolo`
probe. It skips explicitly when the CLI is absent. The live-model suite is
`src/copilot/copilot.integration.test.ts`; run it with real credentials
before recording the Console creation, model choice and room interaction
video required for a provider PR.
