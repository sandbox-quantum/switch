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
| `antigravity` | `agy acp` (Google's Antigravity CLI), ACP over stdio, on the generic ACP adapter; a legacy `antigravity-acp` install still runs | Native sessions, resume, model selection, MCP registration, approvals, and questions as ACP form elicitations. |
| `cursor` | `agent acp`, ACP over stdio, on the generic ACP adapter | Native sessions, model catalogue, MCP registration and approvals, plus Cursor's question, plan, todo and task extensions. |
| `deepseek-harness` | `dsh --profile acp`, ACP over stdio, on the generic ACP adapter | Persistent sessions resumed with `session/resume`, model routes through a `model` config option, MCP registration, cancel, and approvals through a dsh plugin Switch mounts on its `tools/pre-execute` gate. |
| `pi` | `pi --mode rpc`, Pi's own JSONL protocol over stdio, with a Switch extension loaded by `-e` for the session alone | Pi does not speak ACP, and `pi-acp` does not pass MCP servers on to Pi, while Pi itself never asks before a tool runs. The extension registers the session's MCP servers and asks the adapter about every tool call through an extension dialog, so the runtime mode is enforced in the adapter. It asks with the call's input as Pi gives it to the first `tool_call` handler: the user's own extensions load after it and may still change that input. If nothing in Pi connects the session's MCP servers (its built-in MCP support turned off or replaced), the session does not start. Nothing is written to Pi's own configuration. |
| `kimi` | `kimi acp` (Moonshot's Kimi Code CLI), ACP over stdio, on the generic ACP adapter | Native sessions, resume, model selection, MCP registration and approvals; Kimi's questions arrive as permission requests and are surfaced as questions. |
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
| antigravity (ACP) | agy 1.5.1 | 9/10 (2026-11-05) | `subagent` is skipped: it runs past the 300 s deadline, as it did on antigravity-acp 1.1.1. |
| antigravity (legacy `antigravity-acp`) | antigravity-acp 1.1.1 | 9/10 (2026-10-11) | `subagent` is skipped: `invoke_subagent` runs past the 300 s deadline, on main's adapter as on the generic one. `mcp-registered` passes on the generic adapter and timed out on main's. |
| copilot (ACP) | 1.0.105 | 9/10 (2026-11-05, Mistral's `mistral-medium-latest` through `COPILOT_PROVIDER_BASE_URL`) | `user-input` is skipped: `ask_user` is not among the tools Copilot gives the model over ACP, even when the client declares form elicitation. Copilot takes MCP servers over HTTP and SSE only, and drops a stdio one with a warning in its log; Switch serves its tools over HTTP. Mistral needs `COPILOT_PROVIDER_WIRE_API=responses` (on chat completions it refuses Copilot's sampling) and `copilot config effortLevel high` (without reasoning, the model wrote the `approval-declined` command out as text instead of running it). |
| cursor (ACP) | 2026.10.01 | not recorded | The account used hit Cursor's usage limit, so no model turn ran. Set `CURSOR_API_KEY` in the shell to run the suite with a key; the test passes it through. |
| deepseek-harness (ACP) | dsh 0.2.1-rc.5 | 8/10 (2026-11-05), not on DeepSeek's API | **Run without a DeepSeek API key:** dsh 0.2.1-rc.5 ran deepseek-v4-1-flash through an OpenAI-compatible gateway, from a custom `$DSH_HOME` profile adding a pi-ai route and turning off `deepseek-llm-api-extensions`; dsh's built-in `deepseek-official` route was not exercised. `interrupt` is skipped: the harness sends a message only once it is committed, so the counting turn's first text arrives as the turn ends; a separate real-CLI test interrupts a running command. `user-input` is skipped: no ask-the-user tool over ACP. `approval-required` and `approval-declined` passed in the recorded run but timed out in some earlier full runs: outside full access every command asks, and when the model runs a second command to check its work, that one asks too while the scenario answers only the first. Outside full access a subagent's gated calls are refused, with that reason (dsh pins a subagent's approval policy to `never`). Run with `DEEPSEEK_API_KEY` (and `DEEPSEEK_BASE_URL`, `DSH_HOME` if used) in the shell; the test passes them through. |
| pi | 1.5.0 | 8/10 (2026-11-05) | Run with `mistral/devstral-medium-latest`: set a provider's API key in the shell (the test passes `*_API_KEY` through), `SWITCH_PI_MODEL` to a `provider/model` that `pi --list-models` shows, and `SWITCH_PI_BIN` to run a `pi` other than the one on the PATH. Pi has no tool that asks the user (its `question` tool is an example extension, which errors outside the TUI) and no subagent tool, so `user-input` and `subagent` are skipped. Pi never asks before a tool runs: the Switch extension asks the adapter about every call, and auto mode approves edits and asks before commands, as Pi has no automatic review. A mid-turn message queues as its own turn. Without a credential Pi still starts, on a placeholder model that refuses every prompt, so the adapter reads the model from `get_state` and asks for a sign-in. |
| kimi (ACP) | Kimi Code CLI 2.5.0 | 10/10 | Recorded with `anthropic/claude-haiku-4-5` configured in Kimi. Questions arrive as permission requests with `q{n}_*` option ids (Switch advertises no `elicitation.form`) and are surfaced as questions. Auto mode and full access run in Kimi's Ask When Needed mode; its Never Ask mode is not used because it also stops the agent asking questions. Sign-in is read from `kimi provider list --json`. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

## ACP providers

Cursor, Antigravity, DeepSeek Harness and Kimi Code run on one adapter, `src/acp/acp-adapter.ts`, which
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
(`src/cursor/cursor-adapter.ts`, `src/antigravity/antigravity-adapter.ts`,
`src/deepseek-harness/deepseek-harness-acp.ts`, `src/kimi/kimi-acp.ts`):
binary and arguments, the `authenticate` method, the mode for each runtime
mode, how a tool call names its MCP server, sign-in checks, and vendor
extensions.

Permission requests follow one policy for every ACP agent. A tool on an MCP
server the session registered is allowed once without asking, as is
everything in `full-access` and edits in `auto-accept-edits`. Otherwise the
person is offered allow once, allow for this session and reject; options
naming a permanent or future policy are never offered. A request whose tool
call names only its id is described and decided by the call the agent
announced: its title, and whether it runs a command or edits a file.

**Cursor** extensions: `cursor/ask_question` (several questions, multi-select),
`cursor/create_plan` (an approval with the plan as its detail),
`update_todos`, `task` and `generate_image`, each with and without the ACP `_`
prefix. The CLI and default model used for verification did not expose its
AskQuestion tool, so `user-input` is skipped in its conformance run.

**Antigravity** runs Google's `agy` as `agy acp`, with the user's own profile
and sign-in (the OS keychain), so the launch sets nothing up. `agy` signs
itself in when it starts, and refuses `session/list` with `Authentication
required` when it could not. The sign-in check asks exactly that and never
calls `authenticate`: Google's methods open a browser, and `agy` keeps the
method it is sent, so even the API key method would move a user signed in
with Google onto the key for good. A session start sends `authenticate` with
`gemini-api-key` only when the environment has `GEMINI_API_KEY` and
`session/list` was refused. Questions arrive as ACP form elicitations
(`elicitation/create`), which the adapter announces it can answer: each field
with offered answers is a question, the `<field>_other` text `agy` adds beside
it is that question's typed answer, and any other text field is a question
answered by typing. `agy`'s modes are `default`, `accept-edits` and `plan`:
auto mode is `accept-edits`, and full access is `default` with every request
approved by the adapter. A session that advertises no modes is left in its
own. A hosted Antigravity login (the token file of the legacy runtime) is
refused for an `agy` target with an error saying how to sign in there,
rather than written where `agy` never reads it.
A legacy `antigravity-acp` install still runs in its own profile directory
(`GEMINI_HOME`) with its `auto_edit` and `yolo` modes, questions as permission
requests whose tool call id starts with `interaction_`, and its old sign-in
check; its sign-in command is `antigravity-acp --login`, and Update installs
`agy` over it. Native session ids are stored with an `acp:` prefix; a
conversation saved by the retired CLI runtime starts fresh.

**Kimi Code** (`kimi acp`) lists its `login` method in `initialize` whether or
not a token is in place, and `authenticate` is the sign-in itself, so the
sign-in check reads `kimi provider list --json` instead: a managed provider
(`kimi login`) counts while its token file is there, and a provider with an
API key is taken as given. Kimi's modes are permission levels: approval-required
and auto-accept-edits run in `default`, auto mode and full access in `yolo`
(Ask When Needed), and `auto` (Never Ask) is not used because it also stops
the agent asking questions. Switch advertises no `elicitation.form`, so Kimi
sends AskUserQuestion as a permission request with `q{n}_opt_*` / `q{n}_skip`
options, which the `permission` hook turns into a question. MCP tools are named
`mcp__<server>__<tool>`, and `Agent` and `AgentSwarm` calls are subagents.

**DeepSeek Harness** (`dsh --profile acp`) reports every tool call as kind
`other` titled with the tool's name, so its hooks type `bash`/`pwsh` as
commands, `write`/`edit` as file changes and `subagent` as a subagent, title
them by their command or file, and read the MCP server from an
`mcp__<server>__<tool>` name. By itself it asks only to widen its sandbox, so a
command that writes no file would run unasked. Outside full access its launch
therefore mounts a small dsh plugin (`--patch`) on the harness's documented
`tools/pre-execute` gate, which makes every tool ask through dsh's approval
service except a short list that only reads or searches files or manages the
agent's own notes and subagents (`workflow`, `web_fetch`, `web_search`, MCP and
unknown tools all ask). The ACP bridge waits for a service the gate provides,
so dsh refuses to start if it does not load, and a gated launch refuses a dsh
version the gate was not verified with. A widened command asks twice: at the
gate, then for dsh's own widening. The runtime mode decides each request, as
for any ACP agent. Outside full access a subagent's gated calls are refused,
saying why (dsh pins its approvals to `never`), and auto-accept-edits refuses to
start in a directory holding dsh's own settings. Background commands are off (`tool-bash` `enableRunInBackground: false`), since an
interrupt (`session/cancel`) does not stop a background job; a foreground command
that outlives its timeout still becomes one. Every session is created in dsh's own `workspace-write` mode,
because dsh fixes a conversation's mode when it creates it and keeps it on
resume; a call beyond the workspace asks to be widened, and a write widened past
the workspace is not an edit auto-accept-edits allows. Its sign-in check reads
where the harness finds `DEEPSEEK_API_KEY` (its saved credentials, the
environment, the project's `.env`, then `$DSH_HOME/.env`) without starting it,
since `initialize` offers no auth methods either way, and reports a credentials
file dsh would refuse. Model choices are its `[provider, model]` route pairs.
It is not offered on Windows until verified there.
