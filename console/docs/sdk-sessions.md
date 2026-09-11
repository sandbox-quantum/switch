# SDK sessions

Console uses a persistent shared SDK host for Claude Code, Codex, OpenCode,
Gemini CLI and Cursor. Local sessions and sessions reached through SSH use the
same host. SSH, ProxyCommand and ProxyJump carry deployment and management
requests. They do not carry the lifetime of the provider process.

Configured subagents receive their own Console agent row before their room
watcher starts, so their sessions can be discovered and controlled under the
child identity. Existing credentials and provider definitions remain on the
execution machine.

Closing Console leaves the host running. Reopen a session to read its saved
transcript. **Interrupt** ends the active turn. **Stop session** ends the
conversation. **Restart host** stops the current host, waits for process cleanup,
and resumes the saved native conversation under a new server-issued epoch.
A stopped conversation cannot be reopened as a new conversation. Archiving or
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

- Events, upload receipts, command states and room-message assignments are
  written to disk before their acknowledgement advances.
- A lost upload acknowledgement is reconciled with the server. A duplicate
  event or command retains its original identity.
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
outcome. A timeout or interrupted completion remains unknown. Gemini CLI's current
ACP command registry has no compaction operation. The installed Cursor ACP command catalog also advertises no compaction operation. Neither receives a substitute summarization prompt.

| Provider | Reset | Model selection | Native compaction | Attachments |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Native catalog and effort | When `/compact` is advertised | Images as bytes; other files staged |
| Codex | Yes | Native catalog and reasoning effort | App-server compaction | Local images and staged file mentions |
| OpenCode | Yes | Connected models and native variants | Native session compaction | Staged file URLs |
| Gemini CLI | Yes | ACP model catalog | Unavailable | Images/resources as bytes |
| Cursor | Yes | ACP model catalog | Unavailable | Images as bytes; staged file references |

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

Gemini CLI does not support interactive questions through its current adapter;
provide additional instructions in chat. Other capability limits remain explicit
in the session contract. There is no tmux session fallback. Terminal support for
lifecycle scripts is separate.

Recovery requires the saved provider conversation and host state on the same
execution host. Moving that state between machines is not an automatic recovery
operation. Process-group fencing and automatic host replacement require POSIX;
unsupported Windows recovery fails explicitly. The supervisor survives Console
closure and worker crashes, but it is not an operating-system boot service.

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
Console controls. Addressed messages, subscribed join notifications, and task events
retain durable delivery identities. Room attachments are copied from authenticated
server media into session-owned storage; missing media is reported alongside the
message instead of silently dropping the text.

Attachment hashes are stored at upload and checked during download and staging.
Deleting the SDK session also removes its attachment blobs. Older uploads without
a stored digest receive transport checks but have no original-upload integrity proof.

Local Windows execution is currently unavailable because process-group fencing
requires a POSIX host. Use a POSIX SSH execution host. Tmux is optional and applies
only to user terminals and lifecycle scripts; it does not execute SDK sessions.
Codex and Cursor do not advertise interactive questions until their native execution
mode can support that interaction. Approvals remain separate capabilities.
