# SDK sessions

Console uses a persistent shared SDK host for Claude Code, Codex, OpenCode,
Gemini CLI and Cursor. Local sessions and sessions reached through SSH use the
same host. SSH, ProxyCommand and ProxyJump carry deployment and management
requests. They do not carry the lifetime of the provider process.

Closing Console leaves the host running. Reopen a session to read its saved
transcript. **Interrupt** ends the active turn. **Stop session** ends the
conversation. **Restart host** stops the current host, waits for process cleanup,
and resumes the saved native conversation under a new server-issued epoch.
A stopped conversation cannot be reopened as a new conversation.

The execution host supplies the working directory, provider installation,
credentials, environment, shell setup, skills and MCP configuration. Skills and MCP changes take effect when the host restarts. Confirmed model
changes apply to the next turn and survive host restart. A cold
provider startup can take up to two minutes before Console reports a startup
failure. The saved session remains available for inspection after a failure;
its initial prompt is not automatically sent again.

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
- A command dispatched before a crash can have an unknown outcome. Recovery
  marks affected work unknown or interrupted. It does not repeat the action or
  report success without evidence. Use **Check command status** when available.
- Pending approvals and questions remain subject to the server's first-answer
  arbitration. A callback whose outcome is uncertain is not invoked again.
- Room replay gaps stop automatic delivery with a visible error. Review room
  context before starting further work. The host cannot infer missing messages.

## Context, models and attachments

Reset starts a fresh native conversation under a new server-issued epoch. The
transcript remains as history; earlier messages are not inserted into the new
context. Reset requires an idle session with no queued turns or pending requests.
Commands from the previous epoch cannot execute afterward. A crash between reset
intent and durable completion leaves the reset unknown and blocks automatic resume.
Review the outcome before replacing that session; recovery never retries reset.

The model selector shows the native provider's model catalog and available options.
The server and host reject unsupported selections and changes while work is pending.
The host persists a selection only after the native operation succeeds. An uncertain
model change stops further execution until recovery, without repeating the change.

Compaction uses a native operation: Claude's `/compact` with a completed compaction
boundary, Codex's `thread/compact/start` with turn completion, or OpenCode's
`session.summarize` with native busy/idle completion. Console shows progress and the
outcome. A timeout or interrupted completion remains unknown. Gemini CLI's current
ACP command registry has no compaction operation. Cursor compaction is not exposed
by this adapter. Neither receives a substitute summarization prompt.

| Provider | Reset | Model selection | Native compaction | Attachments |
| --- | --- | --- | --- | --- |
| Claude Code | Yes | Native catalog and effort | When `/compact` is advertised | Images as bytes; other files staged |
| Codex | Yes | Native catalog and reasoning effort | App-server compaction | Local images and staged file mentions |
| OpenCode | Yes | Connected providers' models | Native session compaction | Staged file URLs |
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

A remote host needs Node, the selected provider, its own provider authentication,
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
