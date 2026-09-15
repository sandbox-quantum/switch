# Always-on agent process spike

## Decision and scope

Consolidate an agent's room sessions inside its resident host. Preserve one
model conversation per room, with a separate SDK session, connection, lease,
epoch, and saved state for each room. This builds on the SDK session work.

The existing watcher already stays resident and receives addressed events
across rooms. The prototype promotes that dispatcher into a host for multiple
room sessions. The expected saving is the supervisor/worker pair previously
started for each room. Providers and MCP servers may still need subprocesses.
Measure the actual process count with the provider under test.

Threads remain reply destinations within a room's conversation. They do not
create separate model conversations in this spike. Shared model memory across
rooms and operation without Console ever having started the host are separate
product decisions.

## Ownership and routing

- The watcher keeps its all-room discovery connection. Each room session uses
  its own single-room connection; an explicit room claim takes delivery away
  from the watcher for that room.
- Multiple SDK sessions can use the same host ID. Session IDs, epochs,
  journals, command queues, provider state, and connection IDs stay separate.
- The server binds a live single-room connection to one SDK session. Sharing
  that connection between SDK sessions is rejected. Host consolidation does
  not relax this rule or stale-epoch checks.
- Route addressed events by agent and room. Preserve the original message ID
  and thread ID through command admission and response delivery.
- Each provider and tool invocation needs its session's connection context.
  Do not change process-wide environment variables or a shared current-room
  variable as work moves between sessions.
- Message admission verifies the live host, room membership, and the retained
  addressed event. It reserves a message once per agent across SDK sessions.
  It does not establish the room-to-session map: the host must choose the
  correct session, including the first message that starts a room session.
- Stop, reset, and fencing must act on one session's execution resources.
  Killing the resident host's process group to stop one room would stop its
  siblings. A host-wide crash remains a shared failure and must be visible.

The transport currently permits 32 connections per agent. With one discovery
connection and one per active room, this leaves at most 31 room connections
when no other clients use that agent. Reject excess work visibly; do not
silently drop a room or take over another client's connection.

## Recovery policy

Process persistence and durable work are different guarantees. Retain the SDK
session recovery protocol for each hosted room:

1. A brief stream interruption resumes from the saved cursor while the
   connection lease and event retention permit it.
2. Before admission, events live in the server's in-memory replay buffer
   (default: 15 minutes and 2,000 events per agent). A server restart or an
   expired buffer can lose this replay source. Surface the gap and fetch room
   context; do not claim that every missed request was executed.
3. After admission, the command is stored in the database. Retrying the same
   room message returns its existing receipt, including after a lost admission
   acknowledgement. Another SDK session cannot admit that same message again.
4. Before recovering execution, stop the old session's work and mark it
   quiesced. Lease expiry alone is not proof that the old provider stopped.
   Reconcile durable host uploads before obtaining the new epoch.
5. Preserve the server's treatment of uncertain commands and interrupted
   requests. Do not automatically repeat a tool action whose result is unknown.
6. Recover each room independently. A stale epoch or failed recovery in one
   session must not replace another session's epoch or stop its heartbeat.

An in-memory dispatch queue is not durable admission. Likewise, a successful
admission receipt does not prove that a provider completed the command. Keep
these stages distinct in errors and operational status.

## Alternatives

| Approach | Benefit | Cost |
| --- | --- | --- |
| Resident host, separate room connections | Reuses SDK ownership and recovery rules; fewer host processes | Shared host failure; connection limit; provider subprocesses remain |
| One multi-room connection for all SDK sessions | Fewer connections and heartbeats | Changes the single-room binding contract, tool context, and session fencing |
| One model conversation across rooms | Shared conversational context | Changes privacy and context boundaries, scheduling, reset behavior, and context growth |

Use the first approach for the prototype. A multi-room connection needs an
explicit server contract rather than removal of a binding check.

## Acceptance checks

- Start two rooms for one agent and verify distinct provider conversations,
  connection bindings, and saved state under the same resident host.
- Deliver messages to both rooms and replies to two threads in one room.
  Verify destinations and that threads still use their room's conversation.
- Stop or fence one room while the other is active. The sibling must keep its
  lease, connection, and ability to execute work.
- Restart the host during work. Verify independent recovery and a visible
  uncertain outcome where execution cannot safely be determined.
- Retry a lost admission acknowledgement and attempt duplicate admission
  through another session. Verify one durable command reservation.
- Verify stale epochs and connection sharing are rejected, and compare
  process counts before and after with a real provider.

These are acceptance criteria, not a claim that every check has passed. Record
the prototype's empirical results and remaining limits in its pull request.
