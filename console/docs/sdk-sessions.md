# SDK sessions

Console uses a shared SDK host implementation for Claude Code, Codex, OpenCode,
Antigravity, Cursor, DeepSeek Harness, Pi, Kiro CLI and Junie. Local sessions and sessions reached through SSH run
the same host code, but not in the same process tree: an SSH session's host is
deployed to the remote machine and detached from Console, while a local
session's host is supervised by Console itself. SSH, ProxyCommand and ProxyJump
carry deployment and management requests. They do not carry the lifetime of the
provider process.

Configured subagents receive their own Console agent row before their room
watcher starts, so their sessions can be discovered and controlled under the
child identity. Existing credentials and provider definitions remain on the
execution machine.

Closing Console leaves an SSH host running; it stops a local one, along with the
room watcher that started it, because a local agent must not answer when Console
is off. Reopen a session to read its saved transcript. **Interrupt** ends the active turn. **Stop session** stops execution
and preserves the conversation. **Resume session** explicitly reopens its saved
native conversation after process cleanup and server lease recovery. Interrupted
or uncertain work is not repeated. An ordinary reconnect keeps a stopped session
stopped. **Restart session process** performs the same fenced recovery for an
active session. If the provider can no longer resume its saved conversation,
Console shows an explicit recovery decision instead of silently creating one. Archiving or
deleting a session waits for a confirmed server stop, including sessions that
Console has discovered but never opened. If the stop outcome is unknown, the
session remains available for inspection.

The execution host supplies the working directory, provider installation,
credentials, environment, shell setup, skills and MCP configuration. Skills and MCP changes take effect when the host restarts. Confirmed model
changes apply to the next turn and survive host restart. A cold
provider startup can take up to two minutes before Console reports a startup
failure. The saved session remains available for inspection after a failure;
its initial prompt is not automatically sent again.

## Server isolation

SDK sessions, transcript events, commands and attachments are scoped to the
authenticated tenant. PostgreSQL row-level security enforces this boundary.
Session and attachment identifiers can be reused in different tenants without
sharing data or command outcomes. Upgrading an existing SDK database derives
each session’s tenant from its owning agent and preserves its history.

Initial prompts have a saved delivery record. Reopening checks the command receipt before sending. A pending attempt keeps its command ID and original epoch; an unknown or rejected attempt is never sent again automatically. Console shows unresolved or rejected delivery above the transcript. Review the conversation before sending a new message. Older sessions reconcile their legacy command ID first; existing activity without a receipt remains unknown.

Console limits command payloads to 59 KiB so the server can add authenticated
origin metadata within its 60 KiB limit. Larger input must be shortened or attached.
Authorized validation failures have durable rejection receipts. **Check command
status** returns the existing receipt or records that an unaccepted command must
not execute, fencing a late submission with the same ID. It never sends the action
again. A rejected message stays in the composer for review; an unknown answer can
be acknowledged without resubmitting it.

## Recovery guarantees

A reported room-stream cursor reset is saved before delivery continues. Host
restart uses the latest saved cursor, and room/message identities distinguish
messages whose sequence numbers were reused after a server restart. Pending
messages keep their server reservations. The current in-memory stream protocol
only detects a server restart when the client cursor is ahead of the new buffer;
it cannot identify a restart once the new buffer has passed that cursor.

- Events, upload receipts, command states and room-message assignments are
  written to disk before their acknowledgement advances.
- A lost upload acknowledgement is reconciled with the server. A duplicate
  event or command retains its original identity.
- An admitted room message may be handed back in its admission response and run
  from there, but only while nothing else is queued for the session, so it
  cannot overtake a stop or an interrupt asked for earlier. The command endpoint
  still serves it until its result is reported, so a lost response costs a retry
  rather than the message.
- The server owns session leases, recovery epochs, authorization, answer
  arbitration and room publication. Host events cannot grant publication
  authority.
- A live process owner cannot be displaced. Recovery reclaims a dead owner only
  after fencing its provider process group. Lock acquisition and replacement
  tolerate process crashes.
- A transport disconnect does not mean that execution stopped. The host can
  continue while its lease remains valid. Loss of the lease stops execution
  before recovery. The transcript reconnects without resending commands.
- A new command sent with an old epoch receives a durable rejection. Retrying
  a previously recorded command returns its original outcome without executing
  it again. Command IDs are immutable: a new attempt after rejection uses a
  new ID, which Console creates when the user submits again.
- A command dispatched before a crash can have an unknown outcome. Recovery
  marks affected work unknown or interrupted. It does not repeat the action or
  report success without evidence. Use **Check command status** when available. If the server confirms an unknown
  outcome, **Acknowledge unknown outcome and clear draft** releases the composer
  without resending the action or changing its recorded outcome.
- Pending approvals and questions remain subject to the server's first-answer
  arbitration. Unanswered requests expire after at most 30 minutes. The server
  queues an interrupt (or a stop when interrupt is unsupported), without granting
  approval. Already-reserved answers are not cancelled by this timer. A callback
  whose outcome is uncertain is not invoked again.
- Room replay gaps and unaddressed-message counts are included in the next
  delivered prompt so the agent can read room context. If the server
  has lost the evidence needed to verify a received message, the host retains
  its unacknowledged journal entry and stops. Review room context before
  starting further work; automatic recovery cannot reconstruct lost evidence.

An owner can retire an unrecoverable session after its server lease expires. This
permanently fences the old epoch and disables recovery. Unconfirmed commands stay
unknown, pending requests are interrupted, and the transcript remains readable.
Retirement does not claim that an unreachable provider process stopped. Create a
separate session only after reviewing possible external effects of uncertain work.

Console discovers sessions for newly onboarded agents as well as saved agents.
Discovery isolates failed sessions and shows a retryable sidebar error. Additive
session metadata is accepted across versions; invalid required fields still fail.
Adopted sessions do not launch providers. Open their location and select the session
to load its transcript. Existing older Console binaries need an update to receive
these discovery fixes.

## Continuing a Claude Code CLI conversation

A Claude Code agent's session can continue a conversation that was started in
Claude Code's own terminal or IDE clients in the agent's folder. Pick it under
**Conversation** in the new-session dialog. The list is read when that picker
first opens, not with the dialog, on the session's execution host, local or
SSH, with the Agent SDK's `listSessions`. Conversations a program started
through the SDK are left out, Switch's own sessions included, and so are the
copies Console made (below). Only Claude Code conversations can be continued;
Codex runs each session in a private `CODEX_HOME` and records no running
conversations to check against.

Conversations are looked for where the session's Claude Code will look: the
host applies the agent's shell setup and inherited variables, as it does before
starting the provider, so a `CLAUDE_CONFIG_DIR` set there is honoured. Console
sends that request as a private file, in a directory only the user can read
beside a launch's configuration, not on a command line. Listing only reads the
host. On an SSH host that does not yet have this Console's host bundle the
dialog says so instead of deploying it; starting a session, which copies the
conversation, deploys it as any launch does. A Room watcher that does not run
this Console's host bundle cannot start such a session. Before the
conversation is copied, and again before the session's first start, Console
asks which bundle the agent's watcher runs (its `health.json`, written by the
process alive now, or while that process is down its supervisor's record of
the file it starts) and, when it names another build, refuses and says to
update the watcher. A session that cannot start this way never gets a copy. A
watcher whose bundle cannot be told yet (its process has written no record of
its own, or its supervisor names no file) is not refused, nor is a host with
no watcher; a relaunch of a session that has started is not asked about.

The session never writes to the CLI's conversation. Starting the session copies
it under a new id (the SDK's `forkSession`), and the session resumes the copy.
The source is read with `getSessionInfo`, and a copy Console made is refused as
one. Each copy is tagged `switch-console:<session id>` (`tagSession`) as soon as
it is made; a copy that cannot be tagged is removed at once. The session is
recorded before the copy is made. Something that starts it while the copy is
being made waits for the copy. If the copy fails, or the session's row was
deleted while it was made, the session is removed again and Console removes the
conversations in the folder tagged with that session's id, and nothing else; a
copy the host refused, saying why, leaves nothing tagged to remove. When the
copy's outcome is unknown (a timeout or a dropped connection, so it may be made
after Console stopped waiting), or removing it fails, Console tries again in the
background with each list or copy in that location, never holding either up, and
asks the host about every such session in one request. A session is tried until
a removal finds its copy, or until one finds none 15 minutes after it was
recorded, by when a copy still being made would have finished; a removal that
fails does not count. A session read before its copy was recorded finds the copy
in its row. One whose copy was never recorded (Console stopped while copying)
refuses to start rather than open a new conversation. The copy is titled
`… (continued in Switch Console)`, so Claude Code's own `/resume` list shows it
is taken. The dialog never offers a copy, by its tag (a renamed one included)
or by that title (one made before copies were tagged), whether or not its
session still exists. The original stays the terminal's. Continuing it there
afterwards starts a separate branch that does not include what happened in
Console.

A conversation that a running Claude Code process has open cannot be picked, and
the copy is refused if one has opened it since. Claude Code records each running
process under its config directory's `sessions/<pid>.json`, rewriting it as the
process goes busy or idle; a record read half-written is read again. A record
counts while its process is alive and is Claude Code, whatever its recorded start
time says, since a stepped clock moves that. A live process that is something
else no longer holds the conversation unless it started at the recorded time
(`ps -o lstart=` in UTC). A live process `ps` cannot describe is taken to hold
its conversation. When a live Claude Code process's record cannot be read, or
this Claude Code keeps no records, the dialog asks for confirmation that the
conversation is closed. The check runs again when the copy is made: without
that confirmation, a Claude Code that keeps no records refuses the copy and
asks for it, and a record that cannot be read just then refuses it and asks to
try again.

No earlier prompt is sent again. Before the provider starts, the session's
transcript is filled with the copy's earlier turns, up to the last 500 items:
prompts, slash and `!` commands as they were typed (a prompt that quotes Claude
Code's command tags among other text is shown as typed), Claude's replies, and
the tools it ran, with a failed tool marked as failed. Reasoning, subagents' own
messages, the entries Claude Code marks as hidden (a loaded skill's
instructions, say), the context it adds on its own (in its own tags; markup a
person pasted stays) and its notes that a turn was stopped are left out, as they
are from a live transcript. Imported turns carry ids starting `imported:`
(`isImportedTurn` in `@switch-console/shared/session-v1`), and nothing that asks
whether a session has run anything counts them: its initial prompt is still
delivered, its first room message still opens the conversation, and its agent
instructions are not announced as changed. Where the conversation was compacted,
an item marks it instead of showing the summary as a prompt. Text is scrubbed of
service tokens before it is cut into parts, and an item the conversation repeats
is shown once. A notice after those turns says how many items were not shown,
and settles the import: the host reads it back from its event journal on
restart. Items are recorded in batches bounded in count and bytes. An import cut
short by a crash runs again and publishes only what it had not. A saved
transcript is read whole or not at all: only a last line cut short by a write in
progress is left out. If the conversation cannot be read, or its turns cannot be
recorded, a warning says so once and the session goes on to resume it, which
decides whether it is there. Because the session continues a conversation that
already had answers, a copy that cannot be resumed is never quietly replaced
with a new conversation. Console asks for the explicit fresh start instead. Once
the person has taken it, a restart before the fresh conversation has run a turn
starts another without asking, since that one was never the copy and never
answered.

## Context, models and attachments

Reset starts a fresh native conversation under a new server-issued epoch. The
transcript remains as history; earlier messages are not inserted into the new
context. Reset requires an idle session with no queued turns or pending requests.
Commands from the previous epoch cannot execute afterward. A crash between reset
intent and durable completion leaves the reset unknown and blocks automatic resume.
Recovery never retries that reset. When the host requests a decision, choose
**Start a fresh conversation** to submit a new reset. The original outcome stays
unknown, history is retained, and held room messages are delivered to the fresh
conversation through the server's normal reservations. No candidate conversation
from the interrupted reset is resumed automatically.

If Codex reports that the saved conversation has no rollout, the host also waits
for an explicit fresh reset. Some Codex versions do not save a new conversation
until its first turn. Switch retains the transcript and never creates a replacement
conversation or repeats a previous action automatically. Other startup failures
remain visible errors.

The model selector shows the native provider's model catalog and available options.
The server and host reject unsupported selections and changes while work is pending.
The host persists a selection only after the native operation succeeds. An uncertain
model change stops further execution until recovery, without repeating the change.
Codex offers **Keep current effort** because omitting its turn override preserves
the native thread setting. Choose an explicit effort to replace it. Claude
**Provider default** clears the previous session effort override.

Compaction uses a native operation: Claude's `/compact` with a completed compaction
boundary, Codex's `thread/compact/start` with turn completion, or OpenCode's
`session.summarize` with native busy/idle completion. Console shows progress and the
outcome. A timeout or interrupted completion remains unknown. The Antigravity adapter does not expose compaction. The installed Cursor ACP command catalog also advertises no compaction operation, and Kiro's `_kiro/session/compact` extension is not used. None receives a substitute summarization prompt. Pi compacts with its own RPC `compact` command.

| Provider | Reset | Model selection | Native compaction | Attachments |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Native catalog and effort | When `/compact` is advertised | Images as bytes; other files staged |
| Codex | Yes | Native catalog and reasoning effort | App-server compaction | Local images and staged file mentions |
| OpenCode | Yes | Connected models and native variants | Native session compaction | Staged file URLs |
| Antigravity (`agy acp`) | Yes | Native ACP model catalog | Unavailable | Images as bytes; embedded file resources |
| Cursor | Yes | ACP model catalog | Unavailable | Images as bytes; staged file references |
| DeepSeek Harness | Yes | ACP `model` option (its `[provider, model]` routes) | Unavailable | Staged file references |
| Pi | Yes | Models of the providers Pi has credentials for | RPC `compact` | Images as bytes; other files named by path |
| Kiro CLI | Yes | ACP model catalog (a `model` config option on its V3 engine) | Unavailable | Images as bytes; embedded file resources where advertised |
| Mistral Vibe | Yes | ACP model config option | Unavailable | Images as bytes; embedded file resources |
| Junie | Yes | ACP model catalog | Unavailable | Images as bytes where advertised; staged file references |

Controls depend on the connected provider's reported support. OpenCode models
that report no image input are labelled in the selector and reject images before
dispatch. A model can still
reject an image or exhaust its account quota; those failures remain visible.

Attach files with the picker, paste, or drag and drop. Uploads require session-owner
authorization. The server stores bytes and returns durable, session-scoped references.
Only the active authorized host can download them. The host checks length and hash,
then writes private files on the execution machine before provider dispatch. Laptop
paths are never sent as remote attachments. Upload retries retain their attachment
identity; transfer retries cannot repeat a provider action.

Limits are eight files per message and 10 MiB per file. PNG, JPEG, WebP, PDF, UTF-8
text, Markdown, CSV, JSON and opaque binary files are accepted. Filenames cannot
contain directory traversal or control characters. Files remain with the transcript;
there is currently no automatic attachment retention policy.

Native skills, MCP settings and credentials come from the execution host. Managed
provider homes preserve user configuration and add Switch's configuration. OpenCode
retains native JSONC settings and skill directories alongside managed skills.
Relative configuration paths resolve on the execution host. Restart an idle host
after editing skills or MCP; changing a laptop's configuration does not update an
SSH machine. No credentials are copied from the laptop as part of file attachment
transfer.

Codex keeps the sandbox policy from its configuration on the execution host.
Console's automatic approval setting changes approval prompts, not filesystem
permissions. A read-only Codex sandbox remains read-only. Configure the intended
workspace permissions in Codex and restart the host before using file tools.

## Capability and deployment limits

Antigravity runs Google's Antigravity CLI, `agy`, as `agy acp` on macOS, Linux
and Windows. Install it with Google's installer (`curl -fsSL
https://antigravity.google/cli/install.sh | bash`, or on Windows `irm
https://antigravity.google/cli/install.ps1 | iex`, which puts `agy.exe` in
`%LOCALAPPDATA%\agy\bin`). It uses the person's own `agy` sign-in: sign in with
`agy acp --login` on the execution host, or set `GEMINI_API_KEY`, which a
session uses only when `agy` is not signed in itself. The sign-in check asks
`agy acp` for its sessions, which it refuses while signed out, and never signs
in itself. A hosted Antigravity login made for the older runtime cannot sign
`agy` in; a session given one fails with an error saying how to sign in on the
machine instead. Approvals and cancellation use ACP; questions arrive as
ACP form elicitations. A machine that only has the `antigravity-acp` runtime
Switch Console used to install keeps using it, with its own `antigravity-acp
--login`, until `agy` is installed. Conversations saved by that runtime, or by
the older CLI runtime, cannot be resumed by `agy`; reset the conversation to
start fresh while preserving its transcript.
DeepSeek Harness runs `dsh --profile acp` (`npm install -g @deepseek-ai/dsh`)
with the DeepSeek API key it finds on the execution host: saved under Models in
`dsh web`, or `DEEPSEEK_API_KEY`. Outside full access every tool asks first except
those that only read or search files: commands, edits, workflows, web fetches
and MCP calls among them, through a small dsh plugin Switch mounts with
`--patch`, and the runtime mode decides each request. dsh refuses to start if
that plugin does not load, and Switch starts it gated only on a dsh version the
plugin was verified with. A subagent there cannot run what asks, since dsh
refuses a subagent's approvals. Background commands are off, as an interrupt
does not stop them. Sessions run in dsh's `workspace-write` sandbox: on Linux it
needs bubblewrap or Landlock, and without either every command asks to run
unconfined. A user's own `$DSH_HOME/cordis.patch.yml` outranks Switch's settings
and can change the sandbox or approval policy, as Codex's `config.toml` can. It
is not offered on Windows until verified there.
Other capability limits remain explicit
in the session contract. Terminal sessions (tmux/PTY) were removed; SDK adapters
are the only session runtime. Lifecycle scripts use noninteractive commands.

Recovery requires the saved provider conversation and host state on the same
execution host. Moving that state between machines is not an automatic recovery
operation. Fencing after a crash and automatic host replacement use process
groups on macOS and Linux. Windows has none, so there a crashed owner's
leftovers are found by parent process and creation time (PowerShell's CIM
cmdlets), and a host is asked to stop over its IPC channel or a stop file in
its state root rather than by SIGTERM, which Windows cannot deliver to be
caught. The supervisor survives Console closure and worker crashes, but it is
not an operating-system boot service.

A remote host needs Node 20.3 or newer, the selected provider, its own provider authentication,
and network access to Switch and the provider. Local SSH fixture coverage does
not establish that an external host has these dependencies or credentials.

## Verification

Run provider crash and delivery tests with
`pnpm --filter @switch-console/agent-providers test`. Run live provider checks with
`SDK_HOST_LIVE=1 SDK_CAPABILITIES_LIVE=1 pnpm --filter @switch-console/agent-providers exec vitest run src/host/host.integration.test.ts`.
Live tests use the installed providers and their existing authentication.

Backend session and migration tests use real PostgreSQL containers. Run
`uv run --project core pytest core/tests/switch_core/sessions/ core/tests/switch_core/test_migration_chain.py core/tests/switch_core/test_migration_parity.py`.

The desktop's opt-in `shared-host-deployment.integration.test.ts` uses an isolated
local SSH fixture. Set `SDK_SSH_TEST_KEY` to its disposable private-key path and
`SDK_SSH_TEST_PORT` to its published localhost port. The fixture must permit key
authentication as root, provide Node and `/workspace`, and permit TCP forwarding.
The tests exercise real direct SSH, ProxyCommand, ProxyJump, SFTP deployment,
standalone bundle startup and reconnection to saved state. They also execute
attachment staging, transient transfer retry, native skill paths and MCP environment
checks on the SSH machine. The download source and provider are simulated in those
checks; they do not run authenticated providers remotely.

`SDK_ATTACHMENTS_LIVE=1` enables `src/host/attachments.integration.test.ts`. It
requires native project-skill discovery, real MCP invocation, staged document
contents and image recognition when the selected model supports images. Cursor
requires an account with available usage.

## Room discovery and supported execution hosts

A host binds its live room connection to its SDK session through the server.
Console refreshes this binding for existing and newly discovered sessions, including
room detachment. Owner-issued room controls use the same durable command path as
Console controls. Addressed messages and subscribed join notifications retain
durable delivery identities. Room attachments are copied from authenticated
server media into session-owned storage; missing media is reported alongside the
message instead of silently dropping the text.

A turn a room message started that ends without the agent posting to a room — a
provider quota or sign-in error, or a model that answered in plain text — is
answered by the host itself, as the agent, in the message's thread: the agent's
last words (up to 4,000 characters), or that it finished without replying and why
the turn failed. A post is a successful call to one of the Switch tools that
write into a room (`ROOM_POSTING_TOOLS` in `shared-host.ts`), seen as it passes
through the session's own MCP server, so it is recognised the same way for every
provider. The decision is recorded in the session's `inbox.jsonl` before the post,
so a turn is answered at most once, across restarts too. A turn the host stops
itself (a stop, parking, a reset) is not answered, and a post that fails is logged
and noted in the transcript without affecting the session.

Attachment hashes are stored at upload and checked during download and staging.
Deleting the SDK session also removes its attachment blobs. Older uploads without
a stored digest receive transport checks but have no original-upload integrity proof.

Local Windows execution is currently unavailable because process-group fencing
requires a POSIX host. Use a POSIX SSH execution host.
Codex and Cursor do not advertise interactive questions until their native execution
mode can support that interaction. Approvals remain separate capabilities.

### Permission settings

Each agent has two permission settings, applied to every session it starts,
resumes or attaches, including ones started automatically:

- **Auto mode** — the provider's own automatic review: safe actions run without
  asking, risky ones still ask. Claude runs in its auto mode, Codex uses its
  automatic reviewer and keeps its sandbox, OpenCode runs with `--auto`, Cursor
  uses Smart Auto, Mistral Vibe uses Smart Approve where Vibe offers it, and
  Antigravity, Pi (and Mistral Vibe without Smart Approve) approve edits and ask
  before commands. DeepSeek Harness, with no reviewer of its own, asks before every tool except those that only read or search files,
  Junie uses its Auto brave mode, and Kiro applies its own trust policy and safety check before anything reaches
  Console, which asks about the rest.
- **Bypass permissions** — every permission check skipped. Unsafe; it overrides
  auto mode when both are on.

Together they select the session's runtime mode (`runtimeModeFor` in
`@switch-console/agent-providers`): `full-access` with bypass on, `auto` with
only auto mode on, `approval-required` with both off. New agents start with auto
mode on and bypass off, on this computer, on SSH hosts and as managed agents.
Agents that existed before auto mode keep the behaviour they had: auto mode
reads as off for them until someone turns it on.

### Claude permission settings

Switch names Claude's permission mode for every session, so a `defaultMode` in
the person's own Claude settings cannot settle tool calls before Console is
asked. With both settings off Claude runs in `default` mode; auto mode selects
Claude's `auto` mode, where its classifier settles what it judges safe and only
the rest is asked; bypass selects `bypassPermissions`. Claude still applies the
permission rules in its user, project and local settings on the execution host.
Requests that need a human are sent to Console through the SDK permission
callback. Restart the host after changing permission settings.


### Provider sign-in checks

Add Agent checks the selected provider on its execution machine and offers a retry.
The shared worker checks again with the session environment before starting execution.
A confirmed missing login blocks startup and names the sign-in command to run on
that machine. An inconclusive check produces a warning; it is not treated as a
missing login. Existing sessions are not stopped when a setup check fails.

Claude uses its native auth status command. Codex uses app-server account status.
Cursor uses its native account status output. Kiro reads `kiro-cli whoami`
and, when that cannot answer, the agent's handshake, which a signed-out Kiro
answers with its `kiro-login` method. Antigravity initializes an empty
session without sending a prompt, and returns its native model list. Pi lists the
models it has credentials for (`pi --list-models`, offline). Mistral
Vibe uses its read-only `_auth/status` call after the ACP handshake. Junie
initializes an empty session and reads the account it reports for it and
whether it offers a model; a signed-in account without a Junie licence can't be
used and is shown as such. OpenCode checks connected backends; a local or free backend may need no
login. These checks do not prove quota or access to every model, and credentials
can expire after a check. All model fields use the same editable picker: select a model from the host
catalogue or enter an ID. Blank uses the provider default. Loading and failed
catalogue checks are visible and do not prevent text entry. Claude, Codex,
Cursor, Antigravity, Pi and Junie catalogues come from native SDK initialization without a
prompt; each metadata session is stopped after the probe. OpenCode uses its
existing host catalogue.

Complete sign-in in the provider CLI, then select
Check again. Console does not capture passwords or OAuth tokens in this form.

## Opening a session

Console opens the conversation after the execution host has registered with Switch,
while provider initialization and authentication continue in the background. The
chat shows **Connecting** and accepts draft text; sending stays disabled until
the provider is ready. The saved initial prompt is submitted only after readiness,
using its durable command identity. Startup failures remain visible in the chat.
This separates opening the conversation from provider readiness; it does not
promise that a fresh provider process can authenticate in under 500 milliseconds.
