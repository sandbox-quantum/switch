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
| `kiro` | `kiro-cli acp`, ACP over stdio, on the generic ACP adapter | Native sessions and `session/load`, model selection through a `model` config option, MCP registration, approvals, and questions asked as permission requests. |
| `mistral-vibe` | `vibe-acp`, ACP over stdio, on the generic ACP adapter | Native sessions, resume through `session/load`, model selection through a `model` config option, MCP registration, approvals, and questions as ACP form elicitations. |
| `qwen` | `qwen --acp`, ACP over stdio, on the generic ACP adapter | Native sessions, model selection through a `model` config option, MCP registration, approvals and questions; hooks for its modes, sign-in check, tool metadata and question requests. |
| `grok` | `grok --no-auto-update agent stdio`, ACP over stdio, on the generic ACP adapter | Native sessions, resume, model selection through a `model` config option, approvals, and its `_x.ai/ask_user_question` questions. Grok advertises no session modes: it asks before each tool, and full access is the adapter approving each request. Declining a call ends Grok's whole turn, which `declineEndsTurn` completes. |
| `droid` | `droid exec --output-format acp` (Factory Droid), ACP over stdio, on the generic ACP adapter | Native sessions, resume, MCP registration, and approvals; the runtime modes map to Droid's autonomy levels. |
| `cline` | `cline --acp`, ACP over stdio, on the generic ACP adapter | Native sessions, resume, model selection and approvals. Its ACP mode ignores the MCP servers sent in `session/new`, so they go in a per-session settings file named by `CLINE_MCP_SETTINGS_PATH` (`mcpServersAtLaunch`). |
| `junie` | `junie --acp=true`, ACP over stdio, on the generic ACP adapter | Native sessions, resume through `session/load`, model selection through a `model` config option, MCP registration and approvals; its brave mode is set from the runtime mode. |
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
| qwen (ACP) | qwen-code 0.26.1 | not recorded (2026-10-27) | No model account was signed in, so no real model turn ran. Against the real CLI with a scripted local OpenAI-compatible model in place of one, the suite passed 10/10. `subagent` passes only when the model calls `agent` directly: called through Qwen's deferred `tool_call` tool, the item starts as a tool call and is named `agent` only in a later update, so no `item.started` of type `subagent` arrives. |
| qwen (ACP) | qwen-code 0.26.1 | 7/10 (2026-10-27) | Run on Google's free Gemini API (gemini-flash-lite-latest) as an OpenAI-compatible provider, through a local endpoint. Passed: `simple-turn`, `file-write-full-access`, `interrupt`, `steer-mid-turn`, `resume`, `user-input`, `mcp-registered`. `approval-required`, `approval-declined` and `subagent` did not pass, and Qwen's own chat history shows why: the model said it would run the command and stopped, answered "declined" without trying, and called `agent` without its required `description`. None of them reached a permission request. They are not skipped, because a stronger model is expected to pass them. |
| qwen (ACP) | qwen-code 0.26.1 | 9/10 (2026-11-02) | Run on Google's free Gemini API as an OpenAI-compatible provider, through a local endpoint. Passed on 2026-10-27 with gemini-flash-lite-latest: `simple-turn`, `file-write-full-access`, `interrupt`, `steer-mid-turn`, `resume`, `user-input`, `mcp-registered`. Passed on 2026-11-02: `approval-required` and `approval-declined` (gemini-3.8-flash was asked for, but every answer came from gemini-3.6-flash after the endpoint fell back on busy errors). In `subagent` the model delegated correctly through Qwen's deferred `tool_call` and the subagent returned its answer, but the check timed out: the adapter emitted no `item.started` for a subagent that is named only in a later update. The generic ACP adapter now starts such an item again under its real type. With the real CLI and a scripted model replaying that run, `subagent` passes with the fix and times out without it. It has not been rerun on a real model since the fix. |
| qwen (ACP) | qwen-code 0.26.1 | 9/10 (2026-11-02) | Run on Google's free Gemini API as an OpenAI-compatible provider, through a local endpoint. Passed on 2026-10-27 with gemini-flash-lite-latest: `simple-turn`, `file-write-full-access`, `interrupt`, `steer-mid-turn`, `resume`, `user-input`, `mcp-registered`. Passed on 2026-11-02: `approval-required` and `approval-declined` (gemini-3.8-flash was asked for, but every answer came from gemini-3.6-flash after the endpoint fell back on busy errors). In `subagent` the model delegated correctly through Qwen's deferred `tool_call` and the subagent returned its answer, but the check timed out: the adapter emitted no `item.started` for a subagent that is named only in a later update. The generic ACP adapter now starts such an item again under its real type. With the real CLI and a scripted model replaying that run, `subagent` passes with the fix and times out without it. A real-model rerun after the fix passed both approval checks again (gemini-3.8-flash and gemini-3.7-flash answering), but its `subagent` call did not take the deferred path: with the free quota used up, the fallback model called `agent` without its required `description` and Qwen refused it. |
| cursor (ACP) | 2026.10.01 | not recorded | The account used hit Cursor's usage limit, so no model turn ran. Set `CURSOR_API_KEY` in the shell to run the suite with a key; the test passes it through. |
| deepseek-harness (ACP) | dsh 0.2.1-rc.5 | 8/10 (2026-11-05), not on DeepSeek's API | **Run without a DeepSeek API key:** dsh 0.2.1-rc.5 ran deepseek-v4-1-flash through an OpenAI-compatible gateway, from a custom `$DSH_HOME` profile adding a pi-ai route and turning off `deepseek-llm-api-extensions`; dsh's built-in `deepseek-official` route was not exercised. `interrupt` is skipped: the harness sends a message only once it is committed, so the counting turn's first text arrives as the turn ends; a separate real-CLI test interrupts a running command. `user-input` is skipped: no ask-the-user tool over ACP. `approval-required` and `approval-declined` passed in the recorded run but timed out in some earlier full runs: outside full access every command asks, and when the model runs a second command to check its work, that one asks too while the scenario answers only the first. Outside full access a subagent's gated calls are refused, with that reason (dsh pins a subagent's approval policy to `never`). Run with `DEEPSEEK_API_KEY` (and `DEEPSEEK_BASE_URL`, `DSH_HOME` if used) in the shell; the test passes them through. |
| pi | 1.5.0 | 8/10 (2026-11-05) | Run with `mistral/devstral-medium-latest`: set a provider's API key in the shell (the test passes `*_API_KEY` through), `SWITCH_PI_MODEL` to a `provider/model` that `pi --list-models` shows, and `SWITCH_PI_BIN` to run a `pi` other than the one on the PATH. Pi has no tool that asks the user (its `question` tool is an example extension, which errors outside the TUI) and no subagent tool, so `user-input` and `subagent` are skipped. Pi never asks before a tool runs: the Switch extension asks the adapter about every call, and auto mode approves edits and asks before commands, as Pi has no automatic review. A mid-turn message queues as its own turn. Without a credential Pi still starts, on a placeholder model that refuses every prompt, so the adapter reads the model from `get_state` and asks for a sign-in. |
| kiro (ACP) | 3.0.0 | 9/10 (2026-11-04) | Kiro runs Switch's sessions on its V3 engine (it recognises the client); the run with the engine forced to V3 by flag matched. `user-input` is skipped: Kiro offers its `user_input` tool only in its spec workflows, so in the default `vibe` mode (and V2's default agent) it asks in prose and ends the turn. Once, the first session after a controller started was refused `session/set_model` (its `session/new` named no `model` option yet); the host's retry started it, and six more starts with a model did not repeat it. The suite skips itself until `kiro-cli whoami` says signed in; set `KIRO_API_KEY` in the shell to run it with a key, which the test passes through. |
| mistral-vibe (ACP) | vibe-acp 3.1.0 | 10/10 (2026-11-06) | Run on Vibe's default model, Mistral Medium 3.5 (`mistral-vibe-cli-latest`), with the key in `$VIBE_HOME/.env`. A key set as `MISTRAL_API_KEY` in the shell works too; the test passes it, and `VIBE_HOME`, through. |
| goose (ACP) | 1.57.0 | 9/10 (2026-11-04, Amazon Linux 2023) | `user-input` skipped: Goose uses ACP form elicitation, which the generic client does not advertise (`userInput: false`); without the skip the scenario times out at 180s waiting for `user-input.requested`. Real-CLI scenarios run one at a time with 65s spacing; full back-to-back suite can hit Gemini free-tier limits. |
| cline (ACP) | 3.0.74 | 8/10 on Cline's free `nvidia/nemotron-3.5-lightning:free` (2026-11-06; 6/10 on the first of two runs). 4/10 on Groq's free tier (2026-11-05) | Signs in over ACP only with a Cline account, ClinePass or a ChatGPT subscription, or with `CLINE_API_KEY` (then `CLINE_PROVIDER` and `CLINE_MODEL` can pick another provider); a key saved for another provider with `cline auth` is not used. Sessions run in a hub daemon that reads `CLINE_MCP_SETTINGS_PATH` once, so each session gets a daemon of its own. No question tool over ACP, so `user-input` is skipped. Set `CLINE_TEST_MODEL` to pick the model for the suite; without it Cline uses its own default, which needs account credits. ACP model ids carry `:free` where the CLI's carry `-free`. With the free model, `file-write-full-access` and `mcp-registered` each failed once in two runs (`mcp-registered` passes alone). On Windows Cline runs commands in PowerShell 5.1, whose `>` writes UTF-16: `approval-required` fails there, because the model retries after reading the file and the suite answers only the first approval. On Groq, the `reasoning_content` Cline sends back after a tool call is refused, and the free tier's 8000 tokens a minute is about one Cline call. |
| junie (ACP) | 26.11.3 (3959.5) | 8/10 (2026-11-07) | Run with `JUNIE_ANTHROPIC_API_KEY` and `JUNIE_LLM_PROVIDER=anthropic` (Claude Sonnet 5). `user-input` is skipped: Junie asks through ACP elicitation, which the generic adapter does not implement. `approval-declined` is skipped: told it may not be allowed to run the command, Junie in Safe mode answers "declined" without attempting it, so no approval is raised; declining is covered by the unit tests. A JetBrains account without a Junie licence (Junie's log: `NoLicense detected after login`) offers no model and refuses every prompt with `model_not_available`, and a Junie API key from such an account reports `api_key` with the full catalogue but every model call fails with `NO_LICENSE`; the sign-in check reports the former as unusable. |
| grok (ACP) | Grok Build 1.0.77 | 10/10 (2026-11-12, Windows) | Run signed in to a Grok account with `grok login`; a key set as `XAI_API_KEY` in the shell works too, and the test passes it through. Each scenario was run on its own with `-t`. `SWITCH_GROK_BIN` names another binary; on Windows the test runs it through the shell, so the path cannot hold a space. Declining a call ends Grok's whole turn with `cancelled`, which `declineEndsTurn` reports as completed. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

## ACP providers

Cursor, Antigravity, DeepSeek Harness, Kiro, Mistral Vibe, Qwen Code, Cline and Junie run on one adapter, `src/acp/acp-adapter.ts`, which
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
`src/deepseek-harness/deepseek-harness-acp.ts`, `src/kiro/kiro-acp.ts`, `src/mistral-vibe/mistral-vibe-acp.ts`, `src/qwen/qwen-acp.ts`, `src/cline/cline-adapter.ts`, `src/junie/junie-adapter.ts`):
binary and arguments, the `authenticate` method, the mode for each runtime
mode, how a tool call names its MCP server, sign-in checks, and vendor
extensions.

Permission requests follow one policy for every ACP agent. A tool on an MCP
server the session registered is allowed once without asking, as is
everything in `full-access` and edits in `auto-accept-edits`. Otherwise the
person is offered allow once, allow for this session and reject; options
whose name or id names a permanent or future policy are never offered. A request whose tool
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

**Kiro** runs `kiro-cli acp` with no flags. Kiro 3.0 picks the engine itself:
its `acp.agentEngine` setting (V2 by default), except for a client it knows,
and it knows Switch Console by the `clientInfo` name the adapter sends, so
Switch sessions run on the V3 engine whatever that setting says. The V3 engine
refuses V2's `--agent`, `--model` and `--trust-all-tools`, and none is needed:
what a session can do is read from the handshake on either engine. Both
advertise `loadSession`, images and HTTP MCP in `initialize`; V3 also lists
its `_kiro/…` extension methods and session `close`/`fork`, and puts the model
in a `model` config option beside its `mode` and `autopilot` options. V2's
modes are its agents (`kiro_default`, `kiro_planner`), V3's are workflows
(`vibe`, `spec`, `plan`…); neither is a permission level, so no mode is set and
the runtime mode is applied to permission requests. V3 logs that it refreshes
its access token through its host (`_kiro/auth/getAccessToken`), but
`kiro-cli` answers that itself from its own login: no token request reaches
Switch.

Signed out, `kiro-cli acp` answers `initialize` itself, on every engine, with
the single auth method `kiro-login`, and refuses `session/new` with "run
`kiro-cli login`". The sign-in check reads `kiro-cli whoami --format json`
(`{"account":null}` and exit 1 signed out, an `accountType` signed in,
`ApiKey` for a `KIRO_API_KEY`) and falls back to that handshake when it cannot
read the answer; it never sends `authenticate`. `KIRO_API_KEY` is passed
through from the machine.

V3's permission requests name the tool under the request's `_meta.kiro`
(`toolId`, `command`, `mcpTool`) and leave the tool call's `kind` out, so the
hooks copy the kind and the MCP server onto the tool call before the adapter
reads them. Its "Always allow" without a scope is a rule for this session
only, so it is offered as allow for this session; "Always deny" is not offered.
When it does ask a structured question (only in its spec workflows), a
client that does not declare Kiro's own question method gets it as a
permission request whose options are all `allow_once` and which names no
tool; that is asked as a question. On V2 the model list is the session's
`models` list, set with
`session/set_model`; on V3 it is the `model` config option. Sub-agent tasks are tool calls with
`_meta.kiro.kind` set to `agent-subtask`.

**Mistral Vibe** signs in with a Mistral API key, read from `MISTRAL_API_KEY`,
`$VIBE_HOME/.env` or the OS keyring. Its handshake offers browser sign-in
either way, so its sign-in check asks Vibe's read-only `_auth/status` instead.
Sessions are given no keyring bus and the check runs without one too, so on
Linux a key saved to the Secret Service reads as signed out; use the variable
or the `.env` file there. Vibe's modes are permission profiles:
approval-required is `ask`, auto mode is `smart-approve` (Vibe's own reviewer,
which runs the calls it rates safe and asks about the rest) where the session
offers it and `accept-edits` where not, and full access is `auto-approve`.
Vibe ignores a mode it does not offer, and its config can hide any of them, so
a session that has to ask and is offered no mode that asks is refused. Its
`ask_user_question` tool, which Vibe offers only to a client that answers form
elicitations, asks through the same `elicitation/create` handling as `agy`
(`src/acp/elicitation.ts`). An MCP tool is named `mcp_<server>.<tool>` with the
server name normalised; that alias is mapped back to the one registered server
it can name, and a call it cannot place asks a person. Choosing a model also
saves it as Vibe's `active_model` in `$VIBE_HOME/config.toml`, which a later
Vibe session given no model starts with. Its permission requests name only the
tool call, which the `tool_call` announced before them describes.

**Qwen Code** runs `qwen --acp`. A new session starts in Qwen's `auto` mode,
where its own classifier approves actions without asking. That is how
QwenLM/qwen-code#11887 saw tools run with no permission request. So every
runtime mode sets a Qwen mode explicitly: approval-required is `default`,
auto-accept-edits is `auto-edit`, auto is `auto` (its classifier) and
full-access is `yolo`. In `default`, 0.26.1 asks before shell commands and
file writes, and a declined command does not run. Its "Always Allow in
project / for user" options write a rule to Qwen's settings, so they are never
offered. "Allow All Edits" lasts for the session, so it is offered as allow for
this session. `ask_user_question` arrives as a permission request with the
questions in `_meta.qwenQuestions`, and the answers go back beside the
outcome, keyed by question index. MCP tools are called through its deferred
`tool_call` tool, and the request names only `mcp__<server>__<tool>`, which is
where the server is read from. Its `authMethods` are the same signed in or
out, so the sign-in check starts a session instead: `session/new` loads the
configured provider's credentials, runs no model call and stores nothing
until a prompt. It never sends `authenticate`, which in Qwen clears the
cached credentials first.
**Cline** reads its MCP servers from its own settings file, not from
`session/new`, so its `launch` writes the session's servers to a private
temporary `cline_mcp_settings.json` and points `CLINE_MCP_SETTINGS_PATH` at
it; the file is removed when the process exits, and the person's own Cline
settings are not touched. `cline --acp` runs its sessions in a hub daemon that
outlives it and reads `CLINE_MCP_SETTINGS_PATH` once, when it starts, so each
session gets a daemon of its own (`CLINE_HUB_DISCOVERY_PATH` in the same
folder), stopped with `cline hub stop` when the session ends. On Windows Cline
starts a stdio server through the shell, so a command or argument with a space
is quoted. Its sign-in check reads the sign-in Cline saved
(`providers.json`) and never calls `authenticate`. Tool calls are titled
`<tool>: <input>`, and an MCP tool is named `<server>__<tool>`. Cline reports
`apply_patch` as kind `other`, so `toolKind` names it an edit.

**Junie** runs as `junie --acp=true --skip-update-check`. Its permission
level is its brave mode, a session config option rather than an ACP mode:
Safe (`off`) for approval-required, Auto (`brave-auto`) for auto mode, Brave
(`on`) for full access, chosen from the choices the session offers; its ACP
modes (default, plan) are workflows and are left alone. Its "Always allow" writes
`~/.junie/allowlist.json`, which every later run reads, so `allow_always` and
`reject_always` are never offered. An MCP tool call is marked with
`_meta.is_mcp_tool_call` and titled `<server>/<tool>` (`echo/switch_echo`), as
is the permission request for it, which is how a Switch tool call is told from
a connector's; the model sees the tool as `mcp_<server>_<tool>`. A delegated
run is a `think` tool call titled "Subagent <name>", shown as a subagent. Junie lists its sign-in methods whether or not one is in
use, so its sign-in check opens an empty session and reads the account Junie
reports for it (`_auth/status_update`). Junie first reports `none` ("Not
ready") while its account settles and then the account, so a `none` only
counts once nothing better has followed within 10 s. An account that JetBrains
AI authorises no model for (no Junie licence, trial or key) is reported as
`unconfigured` with sign-in marked as no help, since Junie would refuse every
turn with `model_not_available`. `authenticate` is never sent, since for the
account method it is the browser sign-in itself. A `JUNIE_API_KEY` in the
environment counts as signed in; whether its account has an active JetBrains
AI subscription only a model call can tell, and without one Junie cancels the
turn after `NO_LICENSE` from every model. A provider key of one's own
(`JUNIE_ANTHROPIC_API_KEY`, `JUNIE_OPENAI_API_KEY`, …) needs no subscription,
but Junie prefers its JetBrains provider whenever an account is logged in, so
such a setup also sets `JUNIE_LLM_PROVIDER` (both are passed through to
sessions) or chooses one of the provider's models for the agent. With only such a
key (or `JUNIE_LITELLM_URL`), a sign-in check that finds no account reports
Junie as signed in, naming the variable; the key itself is checked at the
first turn.
