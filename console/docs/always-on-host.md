# The always-on agent host

Console's side of the always-on agent process. The decision, the server rules it
has to keep and the recovery policy are in `docs/always-on-agent-process.md` at
the repo root; this page is what the code in
`packages/agent-providers/src/host/` now does.

## What changed

The watcher was already resident — one process per agent, holding the agent's
`scope: 'all'` discovery connection — but it only dispatched. Every addressed
message in a room with no live session made it spawn a whole process tree for
that room.

It now runs the room session itself. `resident-host.ts` holds a map of room →
room session inside the watcher process. Each room session is still a full
`HostedSession`: its own model conversation, its own single-room connection, its
own server lease, epoch and heartbeat, its own state directory and journals, and
its own provider adapter instance. `SWITCH_SDK_SESSION_DISPATCH=spawn` selects
the old path for comparison.

## Process count

Per active room, before: a supervisor, a worker, and inside the worker the
provider process and the Switch MCP server — four, plus the agent's watcher.
After: the provider process and the Switch MCP server, plus one supervisor and
one host for the whole agent. The supervisor/worker pair per room is what goes;
provider and MCP subprocesses stay where the provider requires them, so measure
the real number against the provider under test.

## Containing one session's failure

Nothing kills a process group any more. That was the old teardown, and here it
would take every sibling room with it. Each room session tears down only what is
its own: its provider and MCP children, through its own adapter instance, and
its ownership record, so the next start of that room is not refused by a live
owner that happens to be this very host.

A fault, a stop, a lease expiry or a room the server will not admit ends one
room session, records the reason against that room, and leaves the host and the
other rooms running. The watcher chain that carries every room never fails on
one of them. Stopping is bounded: a session that will not drain is named in the
log and left behind so the host can still exit. A fault in the host itself is
still a shared failure, and is visible as one.

## Per-agent vs per-session

Per agent: the process, the discovery connection, the assignment journal, the
provider sign-in probe (one installation, one working directory), and the
supervisor that restarts the host.

Per session: the room, the Switch session id, the connection id, the lease and
epoch, the command inbox, the chat journal, the room inbox, the provider
conversation, the provider home, and the whole provider child environment.
`SWITCH_CONNECTION_ID` and the session id reach a provider only through that
child's environment; the host never writes them into its own, and
`assertSessionEnvironment` fails loudly if that ever changes.

## Admission

The server verifies agent membership and the retained event when a room message
is submitted, but it cannot check that the event's room is the session's bound
room — the first dispatch happens before any binding exists. The host's room →
session map is therefore the only thing enforcing correct admission, so events
are routed by `event.room_id` and never to whichever session ran last. Two live
sessions claiming one room is refused.

Switch allows 32 connections per agent; discovery spends one and each room
session one more. The local budget of 31 is an early warning only — other
clients of the same agent hold slots too — so the authority is the server's own
refusal: a room not admitted inside the admission window fails the session with
the server's message quoted, rather than sitting behind a stream that retries
for ever.

## The larger alternative

One multi-room connection per agent would drop the per-room connection: one
heartbeat, one cursor, no connection budget, one stream to recover. It needs
server changes — the connection-to-session binding, one connection ↔ one
session, and the per-session fencing hanging off it all assume a single-room
connection — so it is out of scope here. It would also make a per-room failure
harder to contain: today an evicted room connection stops one room.

## Open items

- **Event-loop coupling.** One process now runs every session's timers.
  `flush()` runs every 250ms per session and `replay()` full-scans that
  session's transcript each time, so cost grows with both session count and
  transcript length. Lease renewal is a 5s heartbeat against a 25s deadline; at
  roughly thirty sessions with long transcripts that margin is not obviously
  safe. Nothing here measures or fixes it — it is the known limit of one loop,
  and it wants a benchmark and an incremental replay cursor before real load.
- Threads are reply destinations inside a room's conversation. One conversation
  per room, no thread isolation.
- No idle policy: nothing retires a quiet room to free its connection.
- Stopping the watcher now stops the agent's room sessions, because they are the
  same process. Each quiesces its lease on the way out, so Console can reopen
  them, but "automatic sessions off" is no longer only about starting new ones.
- Lease expiry ends a room session and waits for the next addressed message
  rather than relaunching it the way the supervisor did.
- Restarting a single room session from Console is refused with a message
  naming the host to restart instead.
