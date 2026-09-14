# Compact SDK Slack parity

## Plan

1. Keep activity in the existing thread. The live status is a compact line with the ticking timer and a directly visible **Console app** link. Tool details remain expandable. The same status message shows the final runtime. The tool log stays second, ahead of request cards. No other cards contain Console links.
2. Keep each permission/question request as its own post. For requests initiated by a Slack message, rely on normal thread notifications. Both thread starters and participants normally follow replies. Do not query or override personal notification preferences. For requests without a threaded Slack initiator, use a linked recipient when available.
3. Update routine state in place. Publish one short thread alert for a turn/session failure that needs attention, with navigation available on the status line. Do not expose raw private SDK notices or tool output.
4. On explicit rejection of Block Kit formatting, retry with compact text in the same thread. Preserve typed request handles, stable recovery markers, and edits to the same message. Never retry an uncertain network outcome as a new post.
5. Run focused rendering, publication, and fallback tests. Record exact local and manual Slack test steps below when implementation is complete.

No legacy deletion or architectural refactoring is included. Role restoration and reset/compact confirmation remain with the SDK developer.

## Research

Slack's [thread documentation](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions) says channel/group-DM thread replies notify people who started the thread, replied, or were mentioned. Users can disable these notifications. Therefore an extra mention on every permission card duplicates default notification behaviour without reliably overriding user preferences.

The Console link is directly visible beside the timer. Tool details remain in the expandable plan; timer-only edits do not touch that message.

## Validation and manual test steps

Implementation is complete. Links are presentation metadata built from the configured public server URL and current SDK identifiers. Activity fallback text contains only the plan header, while the blocks retain expandable tool details. An attention message uses a durable slot per command, updates when the problem changes or clears, and does not repeatedly mention the recipient.

### Load the changes

1. Run the Console development build from this checkout. To test Console links against that development build, launch it from `console/` with `SWITCHDASH_REGISTER_DEEPLINK=1 pnpm dev`. This registers the development app as the handler for `switchdash://` links. Otherwise links open the installed Console app.
2. Open the local Switch server page in Console.
3. Enable **Build switch-core from this checkout**.
4. Click **Restart**. Wait for the server to run and the Slack bridge to reconnect. The page should say that switch-core was built from the checkout. These changes run in Switch core; they do not require replacing the SDK host or sidecar.
5. For a managed local server, Console already supplies `GATEWAY_PUBLIC_URL`. For a separately deployed server, set it to the same API address used for that server in Console, then rebuild/restart Switch core. When the setting is absent, the status omits the Console link.

Do not reset the agent to load these changes. Role restoration and reset/compact confirmation are separate upstream fixes.

### Check compact activity and Console navigation

1. Start a test Claude SDK session connected to the Slack room, with **Bypass permissions** disabled.
2. At the channel root, message the agent: `Use Bash to run pwd, then use Bash to run git status --short. Wait for any required approvals.`
3. Verify that activity appears in a thread under your message. There should be no activity broadcast back to the channel root.
4. While the agent is working or waiting, find the compact status line: `Working… 30s · Console app`. The link should stay visible as the timer updates. No expansion is required, and it is not a separate notification or button.
5. Click the link. Console should select the correct server, room, agent, and SDK session.
6. Expand the tool plan. Tool details should still be present, without repeated Console links. Timer-only updates should not redraw or collapse the separate tool log. Tool changes still update that log.
7. After the turn ends, verify that the first status message changes to **Worked for** with the final runtime and **Console app** link. The separate tool log must remain second and expandable; requests stay below it. No status deletion or replacement navigation post should occur. The eyes reaction is removed.
8. Repeat with an agent question before its first tool call. A small **No tool calls yet.** placeholder reserves the second position, then becomes the tool log. No permission or answer card should contain a Console link.

If provider policy allows those commands without asking, use an action already known to require approval in your test setup. Absence of a permission request from the provider is not a Slack rendering failure.

### Check permission posts and notifications

1. Trigger a permission request in the thread above.
2. Verify that it is a separate thread reply with working approval buttons. It should have no Console link, whether open or resolved.
3. Verify that the card contains no extra mention of you. With Slack's default thread notifications enabled, it should appear as a thread reply notification.
4. Approve the request. Verify that the same card changes to its settled state, without a second mention or duplicate request post.
5. Trigger another request and deny it. Confirm that its outcome appears on the same card.

A permission denial is a request outcome, not automatically a turn failure. Its crossed/denied icon is expected. A separate attention reply appears only if the turn fails or the active host/session becomes unavailable or faulted.

6. With a second Slack user, have user A post a root message, then have user B address the agent inside that thread. Trigger an approval. Neither user should get an extra explicit mention. Slack normally notifies both because A started the thread and B replied to it.
7. Check Slack's per-thread notification setting if notifications differ. Switch deliberately does not inspect or override users' muted threads, notification schedules, or device preferences.

For non-Slack origins or unthreaded requests, recipient mapping prefers the initiating person's linked account, then the linked agent owner in that room. Automated tests exercise this branch without requiring a second platform or synthetic production command.

### Exercise errors, retries, and rejected rich rendering

Run from the repository root:

```sh
core/.venv/bin/python -m pytest core/tests/switch_core/bridges/collaboration/test_session_compact_presentation.py core/tests/switch_core/bridges/collaboration/test_slack_block_fallback.py -v
```

These tests simulate Slack's explicit formatting rejection and check that one compact text post keeps the thread, request handle, identity, and recovery marker. They also verify that a fallback edit clears old buttons on the same message. Timeouts, rate limits, and authorization errors must not cause a second post.

For real database-backed notification and failure recovery tests on macOS Docker Desktop:

```sh
DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock" TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock core/.venv/bin/python -m pytest core/tests/switch_core/sessions/test_session_presentation.py core/tests/switch_core/sessions/test_attention_durability.py -v
```

These use a temporary test database and simulated Slack responses. Expected behaviours:

- A failed turn or offline/faulted host produces one concise attention reply in the original thread.
- No raw private provider notice or tool output is copied into that reply.
- Repeated polling, lost acknowledgements, and bridge restarts do not duplicate the alert.
- When the host recovers, the same attention reply updates to remove the stale warning.
- Completed error receipts prevent old alerts being replayed.

No failure-injection switch was added to the production app. These deterministic tests cover failure paths that are hard to trigger reliably in a live workspace. The actual Slack expansion and notification behaviour still needs the manual checks above.

When finished testing links in the development app, run `pnpm run deeplink:reset` from `console/` to restore the installed app as the URL handler.

### Review and automated results

The working-tree review removed unused permission-card Console URL fields, URL construction, and URL parameters. It also removed the unused URL argument from attention replies. Notification recipients are now resolved only for initial open-request publication, since redraws never mention them. These changes preserve the tested Slack layout.

The combined regression suite passed **598 tests**:

```sh
DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock" TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock core/.venv/bin/python -m pytest core/tests/switch_core/sessions core/tests/switch_core/bridges/collaboration/test_session*.py core/tests/switch_core/bridges/collaboration/test_slack_adapter.py core/tests/switch_core/bridges/collaboration/test_slack_block_fallback.py -q --tb=short
```

Mypy passed for all eight changed source files. Ruff and `git diff --check` passed. The tests cover stable message order, completion, restart recovery, uncertain delivery, notification recipients, and text fallback.

The user accepted the rendered layout and repeated the smoke test after the review cleanup. Existing completed threads are not rewritten.

The separate Console startup/session recovery workarounds and nginx DNS change remain untouched and outside the Slack commit scope. Other pre-existing internal notes also remain outside that scope. Legacy deletion, platform expansion, and the upstream reset/compact work are still deferred.
