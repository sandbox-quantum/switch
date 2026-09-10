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
credentials, environment, shell setup, skills and MCP configuration. Provider
settings changed during a session take effect when its host restarts. A cold
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
`SDK_HOST_LIVE=1 pnpm --filter @switch-console/agent-providers exec vitest run src/host/host.integration.test.ts`.
Live tests use the installed providers and their existing authentication.

Backend session and migration tests use real PostgreSQL containers. Run
`uv run --project core pytest core/tests/switch_core/sessions/ core/tests/switch_core/test_migration_chain.py core/tests/switch_core/test_migration_parity.py`.

The desktop's opt-in `shared-host-deployment.integration.test.ts` uses an isolated
local SSH fixture. Set `SDK_SSH_TEST_KEY` to its disposable private-key path and
`SDK_SSH_TEST_PORT` to its published localhost port. The fixture must permit key
authentication as root, provide Node and `/workspace`, and permit TCP forwarding.
The tests exercise real direct SSH, ProxyCommand, ProxyJump, SFTP deployment and
reconnection to saved state. They do not run authenticated providers remotely.
