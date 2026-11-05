# @switch-console/agent-providers

Provider adapters that drive coding agents over their native SDKs and
protocols. These adapters are the only Console session runtime.

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
| `pi` | `pi --mode rpc` spawned per session, JSONL over stdio, with Switch's extension loaded (`-e`) | Pi does not speak ACP, and `pi-acp` neither passes MCP servers through nor has a permission path, so it could not give a session its Switch tools or approvals. RPC mode streams every event, takes `abort`, and forwards extension dialogs, which is how approvals and questions reach the room. |
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
| pi | 1.5.0 | 9/10 | Recorded with `anthropic/claude-haiku-4-5` (`SWITCH_PI_MODEL`). `subagent` is skipped: Pi has no built-in subagent tool, its README leaves sub-agents to extensions. Pi has no permission modes, so the extension asks wherever `approval-required` does, in `auto` mode too. A message sent mid-turn is queued by the adapter, not steered. "Allow for this session" remembers a tool by name. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

## ACP providers

Cursor and Antigravity run on one adapter, `src/acp/acp-adapter.ts`, which
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

## Pi

`src/pi/` drives `pi --mode rpc`, one process per session, on the adapter in
`pi-adapter.ts` and the JSONL client in `rpc.ts`. Pi has no permission system,
no way to ask the user a question and no per-session MCP configuration, so every
session loads a small extension of Switch's (`switch-extension.ts`):

- **It is installed per session, never into Pi's configuration.** The adapter
  writes it, with the session's settings, to a directory of its own under the
  temporary directory and starts Pi with `-e <file>`. Nothing is written to
  `~/.pi` or the project's `.pi/`, and the directory is removed with the
  session. (Pi keeps the conversation itself in its own session store, as it
  does for any `pi`.) The settings hold the session's MCP credentials, so Pi reads them at
  start and the adapter deletes the file then.
- **It registers the session's MCP servers** with `pi.registerMcpServer`, which
  lasts for the session only, in `direct` exposure so the model sees the Switch
  tools as tools of their own.
- **It gates every tool call** (`tool_call` sees Pi's own tools and MCP tools
  alike) on the runtime mode, as the other adapters do: full access asks about
  nothing; the session's own MCP servers are never asked about; auto-accept-edits
  allows `edit` and `write`; every other mode, `auto` included, asks before
  `bash`, `edit`, `write`, connector tools and tools it does not know. Pi has no
  automatic reviewer, so `auto` cannot do better than ask.
- **It asks through one `select` dialog**, which Pi forwards as an
  `extension_ui_request`. Pi's dialogs carry only a title and choices, so the
  title is `switch-pi:` and JSON naming the tool (`protocol.ts`), and the
  choices are the fixed `Allow once`, `Allow for this session` and `Reject`. The
  adapter takes only a dialog with that prefix and those choices for an approval
  and shows its own words (it has the tool's arguments from
  `tool_execution_start`); any other extension's select, input, editor or
  confirm dialog becomes a question or a decision. A rejected or cancelled
  request blocks the tool, and so does an extension that fails.
- **It gives the model `ask_user`**, a multiple-choice question that goes out
  the same way, for `user-input.requested`.

Pi goes on without an extension that fails to load, and a session without the
gate would run tools it should have asked about, so the extension registers a
marker command last and the adapter refuses to start a session unless
`get_commands` lists it.

A turn runs until `agent_settled`, not `agent_end`, which retries and queued work
can follow. The conversation resumes from Pi's session file, whose path is the
native session id; Pi would start a new conversation at a path that holds none,
so a missing file is reported as unavailable and the host starts a fresh one.
Sign-in is read from `get_available_models` (empty when no provider holds a
credential) and never starts a login.
