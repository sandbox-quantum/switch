# The always-on agent host

Console's side of the always-on agent process. The decision, the server rules it
keeps and the recovery policy are in `docs/always-on-agent-process.md` at the
repo root; this page is what the code in `packages/agent-providers/src/host/`
does.

## What changed

The watcher was already resident — one process per agent, holding the agent's
`scope: 'all'` discovery connection — but it only dispatched. Every addressed
message in a room with no live session spawned a whole process tree for that
room.

It now runs the room session itself. `resident-host.ts` holds a map of room →
room session inside the watcher process. Each is still a full `HostedSession`:
its own model conversation, single-room connection, server lease, epoch and
heartbeat, state directory and journals, and its own provider adapter instance.
`SWITCH_SDK_SESSION_DISPATCH=spawn` selects the old path for comparison.

## Process count

Per active room, before: a supervisor, a worker, and inside the worker the
provider process and the Switch MCP server. After: the provider and the MCP
server, plus one supervisor and one host for the whole agent. The
supervisor/worker pair per room is what goes. A live run measured **12
processes before and 8 after**; provider and MCP subprocesses stay where the
provider requires them, so the number depends on the provider under test.

## Containing one session's failure

Nothing kills a process group containing the host. Each room session tears down
only what is its own: its provider and MCP children, through its own adapter
instance, and its ownership record. Providers and their MCP servers lead their
own process group, so teardown reaches the tools they spawned instead of
orphaning them — including when the provider itself has already exited and only
its children are left. Each session's live group ids are written to its state
directory as they are spawned, so a host that is killed outright leaves a record
the next host sweeps before it claims the session.

A provider whose descendants cannot be fenced does not run in the resident host
at all. `fenceableDescendants` on the adapter decides it, and such a room falls
back to a process tree of its own, disclosed: a warning naming the provider and
the reason, an entry in `resident.json`, and a line in the agent's settings.
Claude is the one today.

A group that cannot be proven gone is a teardown failure, and it outranks
whatever caused it: the session keeps its ownership records, the room refuses to
start another session, and nothing tells Switch this host quiesced while a
provider may still be executing. There is no automatic recovery from that.

A fault, a stop, a lease expiry or a room the server will not admit ends one
room session, records the reason against that room, and leaves the host and the
other rooms running. The watcher chain that carries every room never fails on
one of them. Stopping is bounded twice: the host names sessions that outlive the
drain and exits on a code of its own, and the supervisor fences the worker's
group if it has not gone after the grace period.

## Fixed-room ownership

A room session is pinned to its room. `SWITCH_BOUND_ROOM_ID` reaches the
provider's Switch tools and `connect_to_room` refuses another room there —
before the call, because Switch grants a claim the moment it is asked and may
evict whoever held that room. The inbox keeps a second check that stops the
session if an unexpected room change still lands, and a session that has left
its room releases it so the room can be served again.

The server verifies agent membership and the retained event on a room message,
but cannot check the event's room against the session's bound room: the first
dispatch happens before any binding exists. The host's map is the only thing
enforcing it, so events route by `event.room_id`, never to whichever session ran
last. Switch allows 32 connections per agent — discovery spends one, each room
session one more. The local budget of 31 is an early warning; the authority is
the server's refusal, surfaced as a room admission failure quoting it.

## Per-agent vs per-session

Per agent: the process, the discovery connection, the assignment journal, the
provider sign-in probe, and the supervisor that restarts the host.

Per session: the room, session id, connection id, lease and epoch, command
inbox, chat journal, room inbox, provider conversation, provider home, and the
whole provider child environment. `SWITCH_CONNECTION_ID`, the session id and the
bound room reach a provider only through that child's environment; the host
never writes them into its own.

## The larger alternative

One multi-room connection per agent drops the per-room connection: one
heartbeat, one cursor, no connection budget. It needs server changes — the
connection-to-session binding and the per-session fencing hanging off it assume
a single-room connection — and makes a per-room failure harder to contain.

## Open items

- **Event-loop coupling.** `flush()` runs every 250ms per session and `replay()`
  full-scans that session's transcript; lease renewal is a 5s heartbeat against
  a 25s deadline. At ~30 sessions with long transcripts that margin is not
  obviously safe. Unmeasured; wants a benchmark and an incremental replay cursor.
- No thread isolation: one conversation per room, threads are reply destinations.
- No idle policy — nothing retires a quiet room to free its connection.
- Claude's SDK spawns its own provider process and takes no `detached` option,
  so it cannot join the resident host and falls back to a process tree per room.
  Bringing it in needs a fenceable spawn from the SDK.
- The desktop pins the published runtime, which does not yet carry the
  `connect_to_room` guard. A runtime release and a pin bump are needed before
  the fixed-room rule is enforced in shipped Consoles.
- `/gateway/sessions*` is owner-only, so a register-known agent owned by the
  bootstrap service user cannot be stopped through the sessions API at all —
  Console's stop button hits this.
- Spawn-path rooms, which is every Claude room through the fallback, are outside
  the bounded stop: disabling the watcher leaves their process trees running.
  Only sessions inside the resident host are drained and fenced.
- `STOP_GRACE_MS` (30s) is untuned; it only has to sit above the session drain.
- Stopping the watcher stops the agent's room sessions — same process. Each
  quiesces its lease, so Console can reopen them.
