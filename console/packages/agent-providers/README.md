# @switch-console/agent-providers

Provider adapters that drive coding agents over their native SDKs and
protocols. These five adapters are the only Console session runtime.

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
| `qwen` | `qwen --acp`, ACP over stdio, on the generic ACP adapter | Native sessions, model selection through a `model` config option, MCP registration, approvals and questions; hooks for its modes, sign-in check, tool metadata and question requests. |
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
| qwen (ACP) | qwen-code 0.26.1 | not recorded (2026-10-27) | No model account was signed in, so no real model turn ran. Against the real CLI with a scripted local OpenAI-compatible model in place of one, the suite passed 10/10. `subagent` passes only when the model calls `agent` directly: called through Qwen's deferred `tool_call` tool, the item starts as a tool call and is named `agent` only in a later update, so no `item.started` of type `subagent` arrives. |
| qwen (ACP) | qwen-code 0.26.1 | 7/10 (2026-10-27) | Run on Google's free Gemini API (gemini-flash-lite-latest) as an OpenAI-compatible provider, through a local endpoint. Passed: `simple-turn`, `file-write-full-access`, `interrupt`, `steer-mid-turn`, `resume`, `user-input`, `mcp-registered`. `approval-required`, `approval-declined` and `subagent` did not pass, and Qwen's own chat history shows why: the model said it would run the command and stopped, answered "declined" without trying, and called `agent` without its required `description`. None of them reached a permission request. They are not skipped, because a stronger model is expected to pass them. |
| qwen (ACP) | qwen-code 0.26.1 | 9/10 (2026-11-02) | Run on Google's free Gemini API as an OpenAI-compatible provider, through a local endpoint. Passed on 2026-10-27 with gemini-flash-lite-latest: `simple-turn`, `file-write-full-access`, `interrupt`, `steer-mid-turn`, `resume`, `user-input`, `mcp-registered`. Passed on 2026-11-02: `approval-required` and `approval-declined` (gemini-3.8-flash was asked for, but every answer came from gemini-3.6-flash after the endpoint fell back on busy errors). In `subagent` the model delegated correctly through Qwen's deferred `tool_call` and the subagent returned its answer, but the check timed out: the adapter emitted no `item.started` for a subagent that is named only in a later update. The generic ACP adapter now starts such an item again under its real type. With the real CLI and a scripted model replaying that run, `subagent` passes with the fix and times out without it. It has not been rerun on a real model since the fix. |
| cursor (ACP) | 2026.10.01 | not recorded | The account used hit Cursor's usage limit, so no model turn ran. Set `CURSOR_API_KEY` in the shell to run the suite with a key; the test passes it through. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

## ACP providers

Cursor, Antigravity and Qwen Code run on one adapter, `src/acp/acp-adapter.ts`, which
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
`src/qwen/qwen-acp.ts`):
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
