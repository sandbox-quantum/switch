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
| `amp` | `amp threads new`, then `amp threads continue <thread> -x --stream-json --stream-json-input`, one process per session, with a Switch plugin loaded into it | Amp speaks no ACP and its execute mode has no permission prompt: tool permissions are a plugin's `tool.call` hook, so Switch writes one that asks the adapter over a loopback endpoint and blocks the tool until the room answers. The plugin also reports turn ends (`agent.end`) and cancels a turn (`thread.cancel()`); a mid-turn message goes in `steer: true`, which Amp takes up at its next tool boundary, else as the next turn; `amp threads continue` resumes a thread. |
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
| amp | 0.0.1794110442 (@ampcode/cli, 2026-11-08) | 8/10 | Run on 2026-11-08 in mode `medium`, served by an Anthropic key through Amp's model routing: 8 passed, 2 skipped. `interrupt` is skipped: Amp prints each assistant message whole, so the scenario's trigger (the turn's first text) comes after a text-only turn has finished, and a cancel sent then has nothing left to stop; a cancel through the plugin while a `sleep 60` tool ran ended the turn as interrupted and the next turn continued the thread (checked by hand). `user-input` is skipped: Amp's `ask_user_choice` tool has no one to answer it under `amp -x` (a plugin dialog throws without a UI, and the stream carries no question). Checked against the binary: the flags, `amp account list` (`* <email> (user_…)`), plugins loading from the session's `XDG_CONFIG_HOME` with Amp's own runtime, the `init` line arriving only with the first message, `--mode` on the first continue setting the mode (`medium` without one), and a steered message taken up at the next tool boundary. Set `AMP_API_KEY` in the shell to run the suite with a key; the test passes it through. |
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

## Amp

Amp (`src/amp/`) is not ACP and has no permission prompt in execute mode, so
it has an adapter of its own. A session's thread is created first, empty,
with `amp threads new` (it prints the thread's URL and makes no model call),
and every run of the session is `amp threads continue <thread> -x
--stream-json --stream-json-input`: one long-lived process, user messages
written to its stdin as JSON lines, Amp's stream-JSON (the Claude
Code-compatible `system` / `user` / `assistant` / `result` lines) read from
its stdout. Amp prints nothing, not even the `init` line naming the thread,
until a first message is in, which is why the thread id is not read off the
stream at start. Once a message is written the thread must start within 90 s,
or the turn fails, the run is stopped, and the next turn starts another.

**Approvals are a plugin.** Amp decides tool permissions through its plugin
API: a `tool.call` handler runs before every tool and returns `allow` or
`reject-and-continue`, and may await anything first. The adapter writes
`approval-plugin.ts` into the session's own `XDG_CONFIG_HOME/amp/plugins/`
(the only place Amp loads plugins from besides the working tree's
`.amp/plugins/`, which must stay the user's) and starts Amp with the endpoint
and a per-session token in its environment. The plugin posts every tool call
to the adapter; the adapter allows read-only tools, tools on the session's own
MCP servers and everything in full access, lets edits run in auto and
auto-accept-edits, and otherwise opens a `request.opened` and holds the
plugin's request (asking it to poll again every 20 s) until the room answers.
A declined tool is refused inside Amp, so it never runs, whatever the card
shows. Outside full access the session refuses to start when the plugin has
not called in: tools would otherwise run unasked. A stray copy of the plugin
does nothing without the endpoint in its environment.

The plugin also reports `agent.start` / `agent.end`, which is what closes a
turn and says whether it was cancelled (the stream's `stop_reason` cannot),
and long-polls the adapter for an interrupt, which it applies with
`thread.cancel()`. A turn whose end the plugin never reports closes 10 s
after the model's last message; a cancel the plugin cannot apply stops the
process, and the next turn continues the thread (`amp threads continue`).

**Mid-turn messages and interrupts.** Amp prints each assistant message
whole (there is no partial streaming), so nothing of a model step shows
until it is done. A message sent while a turn runs is written `steer: true`:
Amp takes it up at its next interruption point, a tool boundary, where it is
echoed and answered inside the running turn, and the adapter reports it as a
turn of its own that started and ended at once (its reply arrives under the
running turn); with no boundary left, it runs as the next turn. An interrupt
cancels through the plugin and stops a running tool or the model's next
step; a text-only turn is over by the time its text shows, so an interrupt
sent then finds nothing to stop and the turn completes.

**Configuration.** The session's `XDG_CONFIG_HOME` links everything under the
user's configuration root, so git, gh and the rest still find theirs, and
under `amp/` everything but the settings file and the user's own plugins (a
plugin that opens a dialog would stop the thread under `amp -x`; hosted
personal and workspace plugins still load from the server). The settings file
(`--settings-file`) is the user's own with the session's MCP servers merged in
and update checks and notifications off; it carries the Switch server's token,
so it is written private and removed when the session stops. Threads are
created `--visibility private`, and every run of one is
`--no-archive-after-execute`.

**Modes, not models.** Amp picks the model from its Dial mode (`low`,
`medium`, `high`, `ultra`), fixed at a thread's first message, so the mode is
the agent's model choice and there is no in-session switch. `--mode` goes on
the run that sends the thread's first message (given to `threads new` it does
not stick); without one Amp runs `medium`. The `init` line reports the mode
the thread actually runs in, and a difference from the one asked for is a
warning in the room. The Switch skill goes with the thread's first user
message, since execute mode has no system-prompt flag.

**Sign-in.** `AMP_API_KEY` (passed through) counts as signed in; otherwise
`amp account list` is read, which never signs in. `amp login` is the sign-in
command. Amp runs on Windows only through WSL, so the provider is marked
unsupported on a Windows host.
