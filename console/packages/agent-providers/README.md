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
| `antigravity` | `antigravity-acp`, ACP over stdio, on the generic ACP adapter | Native sessions, resume, model selection through a `model` config option, MCP registration, approvals and questions. |
| `cursor` | `agent acp`, ACP over stdio, on the generic ACP adapter | Native sessions, model catalogue, MCP registration and approvals, plus Cursor's question, plan, todo and task extensions. |
| `pi` | `pi --mode rpc` (Pi 1.4.0), JSON lines over stdio, one Pi process per session at a time, started with `-ne -e <bridge> -e builtin:mcp` | Pi's RPC mode carries prompts, events and dialogs. Switch's bridge extension asks the adapter about every tool call through Pi's `confirm` dialog, so approvals are answered from the chat; resume reopens Pi's transcript file with `--session`. |
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
| pi | 1.4.0 exactly (any other version is refused) | not recorded yet | Not offered on Windows; macOS is experimental. Profile, sign-ins, agent controller and the processes a command starts: see [Pi](#pi) below. |
| codex | 0.153.2 | 9/10 | `request_user_input` only works in Plan mode, so `user-input` is skipped. Subagents need `--enable multi_agent_v2`. `turn/steer` joins the running turn. |
| antigravity (ACP) | antigravity-acp 1.1.1 | 9/10 (2026-10-11) | `subagent` is skipped: `invoke_subagent` runs past the 300 s deadline, on main's adapter as on the generic one. `mcp-registered` passes on the generic adapter and timed out on main's. |
| cursor (ACP) | 2026.10.01 | not recorded | The account used hit Cursor's usage limit, so no model turn ran. Set `CURSOR_API_KEY` in the shell to run the suite with a key; the test passes it through. |
| antigravity (retired `agy` adapter, kept for history) | 1.2.4 | 7/10 | Headless `agy` has no prompt channel at all: a tool that needs permission is auto-denied, so `approval-required` and `approval-declined` are skipped and the mode emits a `runtime.warning` at session start. `ask_question` is skipped by the CLI, so `user-input` is skipped. No steering — a mid-turn message queues as its own turn. No in-process cancel: an interrupt kills the process and the next turn respawns on `--conversation`. File tools run in the CLI's own scratch workspace unless `--add-dir <cwd>` is passed. Attachments are passed as file paths in the prompt text: the stream-json input accepts `text` blocks only and rejects `image`. Outside `full-access` a staged attachment is unreadable until its directory is passed as another `--add-dir`, which only takes effect at launch, so such a turn respawns first. A file the `download_attachment` Switch tool fetches lands under `~/.switch/sessions/<runtime pid>/media`, a directory named after a process the adapter never sees and created mid-turn, so outside `full-access` the session is given `~/.switch/sessions` at spawn and those downloads are readable without a respawn. |

### Pi

**Version and platforms**

- Only Pi 1.4.0 runs; Switch refuses any other version at start and in the sign-in check. The
  checks with real Pi were run on 1.4.0; other versions stay refused until they have been tested.
- Not offered on Windows until it is verified there (`unsupportedPlatforms.win32`).
- macOS is experimental. Switch finds the processes a command starts through `/proc`; macOS has
  none, so there it falls back to `ps`, with the gaps listed under *Processes a command starts*
  below.

**Profile**

- Pi always runs in Switch's own profile, `~/.local/state/switch/pi/agent`, and offline.
- A `models.json` in that profile is not supported (Switch refuses to start), so custom model and
  endpoint definitions in `models.json` are out of v1. Endpoint variables Pi reads from the
  environment (such as `AZURE_OPENAI_BASE_URL` or `AWS_ENDPOINT_URL`) are passed to Pi's sessions.
- The variables only Pi reads (Pi's runtime `inheritEnv`) are added to Pi's sessions only, not
  other providers'. The shared list every session host is launched with (`execution.inheritEnv`)
  is part of a session's definition (`withDefinitionOf` in `src/host/agent-host.ts`), so changing
  that shared list restarts the sessions of every provider the next time the definition is
  applied: an idle session restarts on the same conversation, a live one is stopped when the
  watcher starts (`stopRedefinedSessions`).

**Sign-ins in the profile's `auth.json`**

- At start Switch checks every sign-in in the profile's `auth.json` against the fields Pi 1.4.0's
  own login and token refresh write for that provider and sign-in method. It refuses the whole
  profile when one of them holds something else, a key that is a command (`!…`), or an
  environment (`env`). A GitHub Copilot sign-in that names its address must name one in
  `githubcopilot.com`; GitHub Copilot Enterprise is not supported yet.
- The refusal names the provider, the field and the fix: start Pi in the profile, type `/logout`
  and choose that provider, or delete that one entry from `auth.json`; the other sign-ins stay.
- The check runs only when a session starts. A change to `auth.json` during a session (also by a
  `full-access` session's own commands) takes effect for the rest of that session.
- Pi runs as the same system user as Switch and is not isolated from it: a key replaced during a
  session is used as Pi reads it (also a `!…` key, which Pi runs as a command); only the next
  start refuses it.

What to do instead, per sign-in method:

| Sign-in method | `auth.json` | Console / desktop | Agent controller, agents as users of their own (systemd) |
|---|---|---|---|
| provider API key | accepted | the provider's key variable | only the keys listed below |
| OAuth subscriptions | accepted | `/login` in `PI_LOGIN` | none (Anthropic: `ANTHROPIC_AUTH_TOKEN`) |
| GitHub Copilot Enterprise | refused | none in this version | none |
| GitHub Copilot outside `githubcopilot.com` | refused | `/login` again, or `COPILOT_GITHUB_TOKEN` | none |
| Radius, written by an older Pi (`gatewayConfig`) | refused | `/login` again, or `RADIUS_API_KEY` | none |
| Amazon Bedrock with an AWS profile | refused | `AWS_PROFILE` | `AWS_BEARER_TOKEN_BEDROCK`, or both `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN` for temporary credentials; `AWS_REGION` for a region other than `us-east-1`) |
| Google Vertex with ADC or a credentials file | refused | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` | none |
| Cloudflare | refused | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` (and `CLOUDFLARE_GATEWAY_ID`) | none |
| Azure with its address in `env` | refused | `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_BASE_URL` | none: only `AZURE_OPENAI_API_KEY` is passed, not the address Pi needs with it |
| llama.cpp | refused | none (Switch loads no other extensions) | none |

**Signing in**

- `PI_LOGIN` opens Pi's terminal UI: Console's sign-in button without a terminal cannot complete
  `/login`.
- On an agent controller that runs agents as users of their own (systemd), Pi gets provider keys
  only from the controller's environment. Of the variables Pi detects a provider by, only these
  reach it there: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
  `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`,
  `OPENROUTER_API_KEY`, `KIMI_API_KEY`, `MOONSHOT_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`,
  `AWS_ACCESS_KEY_ID`. Some work only with others, which a detecting variable alone doesn't
  replace:
  - `AWS_ACCESS_KEY_ID` needs `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` for temporary
    credentials; the region is `us-east-1` unless `AWS_REGION` or `AWS_DEFAULT_REGION` is set.
    The controller passes all of these.
  - `AZURE_OPENAI_API_KEY` needs `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`, which
    are not passed, so Azure from the environment does not work on such a controller.
- `/login` on such a controller signs in a profile no agent reads.
- That controller runs its sign-in check with the marker its agents run with
  (`SWITCH_HOST_SHARED_GROUP=1`), so the check says that `/login` won't help there instead of
  suggesting it.

**Processes a command starts**

- Switch's bridge runs Pi's `bash` tool itself and records the process group of every shell it
  starts. Stop and interrupt signal those groups only after checking that a group is still the
  one it started. With `/proc` (Linux), cleanup also signals individual processes carrying the
  recorded command marker, including processes outside those groups.
- On stop and on `!interrupt` Pi 1.4.0 aborts the running tool, and the bridge kills that
  command's process group (probes on Linux, with `/proc` and with the `ps` path forced; see
  below).
- Every shell carries a random 128-bit label of its own in its command line, on Linux too. The
  label is visible to every user of the machine in the process list; it is random and says
  nothing about the command. Each `-c` command therefore sees one positional parameter (`$1` =
  label, `$#` = 1); `$0` and error messages are unchanged.
- Switch says it stopped commands only when it confirmed that they are gone; otherwise it says it
  could not confirm it, and does not start that conversation again until they are gone.
- A shell's process group number taken by another process is recognised only when that process
  leads its group with a start time other than the shell's as recorded (with `/proc` exactly;
  without `/proc` to the second). In the same second on the `ps` path, or when the start was not
  recorded or cannot be read, the group still counts as the shell's, and the conversation waits
  until that process ends.
- A confirmed cleanup covers the shells' process groups and what Switch could find of them, not
  every descendant: a process that left its group and dropped its environment
  (`setsid env -i …`) is not found, also with `/proc`.
- The process registry the checks read is a file the model's commands can write, as they run as
  the same user. The checks are defensive, as against another extension in the Pi process; they
  are not a security boundary.
- On Linux, a process of the same user whose environment cannot be read (one that is not
  dumpable, such as a sandboxed helper), started after the Switch host, keeps a cleanup
  unconfirmed: Switch cannot tell that it is not Pi. Such a process started before the host is
  skipped.
- Without `/proc` (macOS) Switch uses `ps`. In probes with real Pi 1.4.0 on Linux, also with the
  `ps` path forced, stop and `!interrupt` ended a plain command (also one bash runs with `exec`);
  a job left in the group after its shell exited (`cmd & exit 0`) stayed. Not measured on macOS.
  There:
  - a shell is recognised by its label in its command line. A command that `exec`s
    itself keeping its exact command line (label included) is still taken for the approved
    shell: it is that command's own process. If `exec` changes the command line, the adapter's
    `ps` check refuses to signal that group; this does not prevent the `exec`. The live bridge
    can still signal its own shell's group on abort while that shell is not yet reaped;
  - a job a command leaves in its group after its shell exited (such as `cmd & exit 0`) cannot be
    verified: stopping or interrupting leaves its cleanup unconfirmed and the conversation
    blocked. A stop that saw Pi exit but could not confirm the job records Pi's exit; once that
    job has ended, the next start of the conversation (in any Switch, also after a restart) and
    the recovery procedure confirm it and resume. Its groups, intended and labelled shells are
    still checked; only Pi is not looked for again;
  - if Pi itself dies (crash, `SIGKILL`) while a command runs, its shells can no longer be
    verified: cleanup stays unconfirmed and the conversation blocked;
  - if the Switch host itself dies while a Pi session runs (no stop recorded Pi's exit), Switch
    cannot confirm that this Pi is gone: the conversation stays blocked until its launch
    directory under `<state>/run` is removed by someone who knows Pi and its commands ended;
  - a process that left the shell's group (`setsid`) carries no label and is not found: the
    cleanup is confirmed while it may still run;
  - a shell started with arguments other than a final `-c` or `-s` gets no label and is never
    verified (Pi's own shells run with a final `-c`, or `-s` for a legacy WSL bash);
  - recovering a conversation (`pi-recover.mjs`) refuses while the conversation has a launch
    whose processes were not accounted for and whose Pi's exit was not recorded, because Pi
    itself cannot be seen there; a conversation without one is recovered. How macOS prints `ps -o args=` has not been checked
    on a Mac: a difference can prevent the adapter's verification (it then refuses to signal);
    the live bridge's own signal on abort does not depend on it.
- If a lock link answered an error and its probe failed, the lock is kept and released once the
  file system answers; if its temporary file disappears meanwhile, the conversation stays held
  by this Switch until it restarts.
- Two Switch processes on one state directory: a launch directory a live Switch is still
  preparing (`<state>/run/.preparing-*`) is not removed. One left by a start that was cut short
  is removed once its owner file (`owner.json`, written first) is whole and its maker is surely
  gone. One whose maker died before its owner file was whole (missing, cut off or damaged) is
  left in place (nothing in it runs). It never blocks a start; without `/proc` it keeps the
  recovery procedure of that state directory from running until it is removed by hand.

**Other limits**

- Pi loads only Switch's bridge and Pi's built-in MCP extension (`-ne`). Defending against another
  extension loaded into the same Pi process is outside the bridge's threat model.
- All Pi sessions share one profile. Concurrent token refresh relies on Pi's own lock on
  `auth.json`; whether that survives an interrupted write was not tested.
- Pi 1.4.0 exits when it can't write a long command output to its temporary directory (upstream
  #10585, not fixed in 1.5.0). Switch then ends the turn with an error that says so and stops the
  shells' recorded process groups, within the limits above.
- A command that closes its own stdin is treated as Pi treats it: the shell's real result counts,
  and a hang is caught by the timeout or an interrupt.
- `full-access` shows no approval cards at all, as with the other providers, including MCP
  resource tools, MCP tools whose server can't be established and edits outside the session
  directory.
- Pi has no automatic review, so `auto` mode asks like `approval-required`.
- When neither Claude nor Codex is ready, the Buddy setup screen also waits for Pi's sign-in
  check, up to its 45-second limit.

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
