# Agent Bridge Protocol

Status: **Stages A and B implemented; Stage C outstanding** (CHOO-1857, closed)

This began as a design proposal and is now largely built. The connection model,
scope/filter/room slots, the heartbeat and state machine, the event envelope and
its payloads, the operations registry and both front doors all describe shipped
behaviour. What remains is Stage C — retiring `connection_model` — plus the
individual items still marked as proposed below. Trust a section that describes
current behaviour; check anything labelled *proposed*.

This document specifies the protocol between an agent and Switch: how an agent
connects, what it receives, what it sends, and what happens when things break.
It replaces the long-poll delivery Switch originally shipped, and is the
authoritative spec for the connection model `ARCHITECTURE.md` §4.3 summarises.

---

## 1. Why this changes

Four problems in the model this replaces, all structural rather than
incidental. Three are now fixed; the fourth is Stage C and still live.

**Two sources of truth for "which session is in which room."** *(fixed —
`connect_to_room` claims the room on the caller's own connection.)*
`connect_to_room`
is an MCP tool that writes a row keyed on the MCP transport session id, while
events are fetched over an unrelated HTTP request that never mentions it. The
thing that joined the room and the thing receiving that room's events are two
independent connections sharing only an agent id. Neither notices when the
other dies. Clients then keep their own copies — Switch Console persists a
session→room map to SQLite, the remote reconciler mirrors it, the sidecar keeps
a third — so the same fact is stored four times and reconciled nowhere.

**Events are held in memory and destroyed on read.** *(fixed — the buffer is
read, never drained, with a cursor per reader.)* The event queue was a
per-agent, per-room `asyncio.Queue`. A poll *removed* what it returned, so only
one consumer could exist (hence `SWITCH_CHANNEL_DISABLE_POLL`, which Switch
Console set to stop the connector stealing its events; the variable still
exists, repurposed — see below). Nothing survived a restart, and there was no
way to ask "what did I miss?" because no record was kept.

**Liveness is guessed from timestamps by every reader independently.** *(fixed —
`POST /connection/beat` owns the answer, and status computation takes the
connection registry.)* Three heartbeat endpoints with three cadences and three
TTLs existed because there were three connection models. Each caller compared
`last_seen_at` against a TTL at read time; nobody owned the answer. There was no
session-close signal at all, so bindings lingered until they expired.

**Connection models leak agent implementation details into the server.**
*(still true — this is Stage C.)*
`always_on` / `session_addressable` / `session_passive` / `auto_session` is
branched on throughout the server, but almost all of those reduce to "is there a
live connection, and what does it cover" — facts the server could observe rather
than be told.

### Non-goals

- Horizontal scaling. `switch-core` is single-process by construction (the Helm
  chart refuses `replicaCount != 1` because Matrix sync sessions live in
  memory). This design assumes one process and notes the seams where that
  assumption is load-bearing.
- Replacing MCP. MCP remains the agent's tool surface.
- AG-UI (CHOO-1685), which is being worked separately. This design should not
  make it harder to land; it does not attempt it.

---

## 2. Model

### 2.1 The connection

A **connection** is the unit of everything. It is created by opening the event
stream and it owns:

- **scope** — which rooms it covers
- **filter** — which events within those rooms
- **cursor** — how far the client has consumed
- **liveness** — its heartbeat
- **room slots** — its exclusive right to act as the agent in a room
- **role lease** — the room role it holds, if any

A connection belongs to exactly one agent. An agent may have several.

The connection is held **in memory only**. It cannot outlive the server
process (its socket and buffer cannot), so persisting it would recreate the
staleness bug. Every question of the form "is this agent reachable in room R?"
is answered from the live connection set, not from a table.

### 2.2 Scope

Declared when the stream opens, mutable while it is open.

| scope | meaning | typical client |
|---|---|---|
| `single` | at most one room at a time; subscribing to a new room drops the previous | a terminal coding session |
| `all` | every room the agent belongs to, including rooms joined later | a supervising daemon, an always-on agent |

`single` is `all` with a limit of one. The limit is enforced server-side, so
"one room at a time" is a guarantee rather than a convention in a skill.

Scope is always a subset of the rooms the agent is already a member of.
Subscribing is not joining; membership is checked per subscribe.

### 2.3 Filter

Also declared at open. Orthogonal to scope: scope selects *rooms*, filter
selects *events within them*.

| filter | delivers |
|---|---|
| `all` | every event in subscribed rooms, each carrying `addressed` |
| `addressed` | only addressed messages, task events, and opted-in room joins |

A session uses `single` + `all` — it needs unaddressed traffic for context and
for missed-message counts. A daemon uses `all` + `addressed` — it is watching
for a reason to start a session, not following conversations. This is what
makes the separate `/notifications` endpoint and the second notification builder
(CHOO-1810) removable — neither has actually been removed yet.

### 2.4 Room slots

**At most one connection per (agent, room) may act as that agent in that room.**

- A `single`-scope connection **claims** the slot for its room.
- An `all`-scope connection covers every room **not** claimed by another
  connection of the same agent.
- When a `single` connection claims room R, the `all` connection **goes fully
  dark on R** — it receives nothing for R until the claim is released.
- When the claiming connection dies, coverage returns to the `all` connection
  automatically.

Exactly one recipient per room at all times: no duplicate delivery, no
coordination needed for handoff in either direction.

This rule was originally implemented client-side in `auto-session-watcher.ts`,
which skipped a room when Switch Console's own map said a session covered it.
That move into the protocol has happened: the server answers the question by
never delivering the event, and the client keeps no copy of the fact. What
remains client-side is only a narrow spawn-in-flight guard over the live
connection map, which is deliberately not a persisted mirror.

**Collision.** If a `single` connection tries to claim a room already claimed
by a live connection of the same agent, the claim is **rejected** with an error
naming the incumbent. The common cause is an accident (a stale process, a
double launch) and rejecting surfaces it. An explicit takeover flag forces the
claim, evicting the incumbent, which is told why.

**`connect_to_room` takes over rather than rejecting** (CHOO-1419). A tool call
is not a client negotiating for a slot: it is a session that has already been
started to work in this room and has nowhere else to go, so refusing it strands
a live session instead of resolving the duplicate. It claims with takeover and
returns a `warning` naming the room and the evicted connection; the incumbent
learns it lost the room from `subscription_changed` on its own stream. Reporting
is the load-bearing half — an unannounced takeover is indistinguishable from the
duplicate-session bug it resolves, because in both a session stops receiving a
room and nothing says why. A **dead** incumbent is not an eviction and is not
reported: `claimant_of` filters on liveness, so a restart meeting its own stale
connection displaces nobody.

### 2.5 Sessions are not a server concept

Switch models connections, not sessions. Whether a client runs one PTY or ten
behind a connection is its own business.

A daemon that spawns sessions does not relay events to them: each spawned
session opens **its own** `single`-scope connection. Consequences: correlation
stays structural (each session's stream and MCP live in one process), failure
is isolated (the daemon dying does not disconnect running sessions), and a bare
terminal session with no daemon works identically.

A client may later multiplex sessions behind one connection. Switch does not
need to change for that.

---

## 3. Transport

**SSE for server→agent, ordinary HTTP for agent→server.**

The two directions have different shapes. Downward is a stream: events happen
whenever, the agent listens. Upward is request/response: each action wants a
result. SSE plus HTTP uses each for what it already does, rather than
rebuilding request semantics inside a WebSocket frame protocol.

Reasons, in order of weight:

1. **Resume is specified.** SSE tags events with ids and clients reconnect with
   `Last-Event-ID` automatically. Gap recovery after a laptop sleeps is the
   spec, not something we invent.
2. **It survives the network.** SSE is plain HTTP, so proxies, K8s ingress,
   corporate networks and SSH port-forwards pass it through. WebSocket's
   upgrade handshake is a class of "works on my machine" failure we would own.
3. **It is debuggable.** `curl -N .../events` shows the live stream.

Both are client-initiated, so agents work behind NAT with only outbound HTTPS.
**Switch can never wake a disconnected agent** — with no connection, events
queue. Anything resembling "Switch starts a session on demand" must be done by
something already connected and local.

**Accepted cost:** two channels can fail independently. §5.3 binds them.

---

## 4. The event buffer

### 4.1 Shape

Per agent, an ordered buffer of recent events, each with a monotonically
increasing **sequence number**. Events are appended when produced and removed
only when confirmed or aged out — **never on read**.

Delivery becomes a read, which makes it repeatable, resumable and verifiable.
It also permits more than one reader, which removed the reason
`SWITCH_CHANNEL_DISABLE_POLL` existed (see §12 for what became of it).

The buffer is **in memory** for the first implementation. Restart loses
undelivered events — accepted, and made loud (§5.5). It sits behind a narrow
interface (`append`, `read_from`, `confirm`, `prune`) so it can be moved to
Postgres later without anything above it changing.

> **Why not Kafka / Redis Streams / NATS?** Event volume is human chat scale —
> order of one event per second aggregate. A broker's central benefit is
> decoupling producers from consumers for independent scaling, which
> `switch-core` cannot use while it is pinned to one replica. Against that: a
> new stateful service in the Helm chart, in compose, in CI and in every dev
> setup, plus a "committed to the DB, failed to publish" failure mode we do not
> have today. If the buffer ever needs to leave the process, Postgres first
> (`LISTEN/NOTIFY` for the wakeup), Redis Streams second — its stream ids are
> the same cursor concept.

### 4.2 Bounding and gaps

The current queue is unbounded: an agent that never connects accumulates
forever in RAM. The buffer is **capped per agent**. On overflow the oldest
events are dropped and the agent is flagged as having a **gap**.

A gap is never silent. The next connection for that agent is told it missed
events and must re-read room context. The same applies when a client asks to
start from a sequence number older than the buffer retains: that is an
**error**, not a fast-forward to head.

Never silent is not the same as immediate. A gap is reported to the *client*
the moment it is detected, but a client must not wake its agent for one on its
own: the only available response is to re-read context, and the agent cannot
know whether anything it cared about was dropped, so an interrupt per hiccup
buys a turn spent on a maybe. Clients hold the reason and attach it to the next
event they surface — still ahead of any reply that stale context could skew,
at no cost of its own. A gap that is never followed by a surfaced event is one
the agent had no turn to misuse anyway; it stays in the client's log.

### 4.3 Confirmation

Two mechanisms, both free:

- **On reconnect** — `Last-Event-ID` states what the client processed. This is
  what makes resume correct.
- **Piggybacked** — the heartbeat and every agent→server call carry the
  client's current sequence number, so the buffer trims during long-lived
  connections rather than growing to the cap.

The cursor is **monotonic per connection**. A client may not move it backwards
to force replay; history is `read_context`'s job, not the stream's.

### 4.4 Starting position

Chosen once, at open:

- **head** (default) — only events from now on. Correct for a session a human
  started; nobody is waiting on a specific event.
- **from a given sequence number** — used on reconnect, and by a spawner.

When a daemon spawns a session in response to an event, it passes that event's
sequence number to the session, which opens its connection just below it. The
session therefore receives exactly the message that woke it, and nothing else,
without relying on the agent thinking to go looking.

The trigger event is consequently delivered twice — once to the daemon that
used it to decide to spawn, once to the session that acts on it. This is
intended.

---

## 5. Connection lifecycle

### 5.1 Opening

```
GET /agents/{agent_id}/events
Authorization: Bearer <agent token>
Accept: text/event-stream

  connection_id   client-generated UUID
  scope           single | all
  filter          all | addressed
  start_from      head | <sequence number>       (default head)
  spawn_capable   bool                            (default false)

  protocol          newest agent-protocol revision the client implements
  protocol_accepts  oldest it still handles       (default: same as protocol)
  client            artifact name, e.g. agent-runtime
  client_version    that artifact's semver
```

The client generates the connection id, which makes opening **idempotent**: a
timed-out request can be retried without creating a second connection. The id
identifies, it does not authorise — the agent token does that — so it need not
be treated as a secret. An id belonging to a different agent is rejected.

The server responds with an open `text/event-stream` and sends the connection's
state as the first event.

**The four declaration parameters are optional, and absent means _unknown_.** A
client built before they existed says nothing, and unknown is a state the model
carries deliberately — it is not incompatible, and such a client connects
normally (CHOO-1865). `protocol` previously defaulted to the server's own value,
which read silence as agreement; since no shipped client sent it, the check had
never once fired.

`client` and `client_version` say which released artifact is connecting and
where it is. They are recorded and reported, never judged: a semver says nothing
about compatibility. That is what the contract revisions are for.

**A declared protocol range is checked at open.** Client and server are
compatible when their `[accepts, speaks]` ranges **overlap** — not when they are
equal — and they then operate at the lower of the two `speaks`. A client whose
range cannot meet the server's is refused with a `409` whose body carries both
ranges and names which side is behind:

```json
{
  "detail": {
    "message": "...",
    "contract": "agent-protocol",
    "server": { "version": "0.12.3", "speaks": 1, "accepts": 1 },
    "client": { "speaks": 2, "accepts": 2 },
    "remedy": "update switch-core"
  }
}
```

The refusal carries the ranges because a refused client never receives a
`connection_state` frame, so this is its only chance to learn what the server
speaks. The runtime lives on the user's machine and Switch moves independently;
silent degradation is not acceptable, and neither is a refusal that leaves the
user guessing which side to move.

### 5.2 Heartbeat

```
POST /agents/{agent_id}/connection/beat
  connection_id
  cursor            last sequence number processed
```

Every **2 s**; TTL **6 s**. One heartbeat for every kind of connection. It
replaces all three of today's: `/connection/renew`, `/watch/heartbeat` and
`/leases/renew`.

It does two jobs: proves the client is alive *and* consuming (strictly stronger
than a server-side write succeeding), and confirms the cursor so the buffer can
trim.

The server also writes a keepalive comment down the stream periodically. That
is only to stop proxies timing out an idle connection — it is **not** the
liveness signal.

### 5.3 The two signals

A connection has two independent signals: whether a **stream is attached**, and
whether the **heartbeat is fresh**.

| stream | heartbeat | state |
|---|---|---|
| attached | fresh | **healthy** — events flow |
| detached | fresh | **alive, not receiving** — keeps slot and lease; events buffer; heartbeat is *rejected* with "no stream attached, reopen" |
| attached | stale | **dead** — half-open socket; drop stream, release slot and lease |
| detached | stale | **dead** |

**The connection dies when the heartbeat goes stale. Losing the stream does not
kill it; it only stops delivery.**

This is what makes a 6 s TTL safe. A brief network drop detaches the stream,
the connection survives, the client reattaches with the same connection id and
resumes from its cursor — keeping its room slot and role lease. Without the
grace window, a wifi hiccup would drop an agent's role.

Reconnecting with an id that is already live **takes over**: the previous
stream is dropped with an explicit reason. "Same client returning" and "same
client duplicated" are indistinguishable, and takeover is right for both.

### 5.4 Binding the two channels

Every agent→server call carries the `connection_id`. The server checks it
against the live connection set:

- live → accept
- unknown or dead → **reject** with "your stream is not connected; reconnect and
  resume from your cursor"

This is the coupling a single WebSocket would give for free, obtained with one
field. It means an agent whose stream died cannot keep acting as though
connected: it is told on its very next action.

Correlation is always **derived** by the server — from the credential or the
local socket — never accepted as a claim in a request body.

### 5.5 Restart

On restart there are zero connections; every client reconnects. This is the
truth, and the server must not pretend otherwise.

The server marks a fresh start. A client resuming with a cursor from a previous
process is told its cursor is meaningless and it must re-read context. Never a
quiet resume that looks healthy.

### 5.6 Closing

- Stream closes → detach, grace window per §5.3.
- Heartbeat lapses → connection dies: slots released, role lease released,
  buffer for that connection discarded.

---

## 6. Events (server → agent)

Wire format is SSE. Each event carries `id` (the sequence number), `event`
(the type) and `data` (JSON).

```
id: 4813
event: message
data: {"type":"message","room_id":"…","bridge_id":"…","channel_type":"channel_public",
       "payload":{…}}
```

### 6.1 Envelope

| field | type | notes |
|---|---|---|
| `type` | string | one of the types below |
| `room_id` | string | Switch room id |
| `room_name` | string | *proposed, not implemented* — `all`-scope clients receive events for rooms they never explicitly connected to |
| `bridge_id` | string \| null | collaboration bridge, if any |
| `channel_type` | string \| null | `channel_public`, `channel_private`, `direct` |
| `payload` | object | per type |

### 6.2 `message`

```json
{ "addressed": true, "sender": "@switch-slack-alice:switch.local",
  "sender_name": "alice", "message_id": "$abc…", "body": "…",
  "timestamp": 1785569372682, "thread_id": "$root…",
  "attachments": [ { "filename": "diagram.png", "mimetype": "image/png",
                     "size": 20481, "mxc": "mxc://…", "msgtype": "m.image" } ] }
```

`addressed` is computed server-side: true for a `direct` channel, an `@name` or
`@alias` mention, or an `@role` mention whose role this agent holds. The
addressing policy is applied at this point — a mention from a sender not
permitted to address this agent is demoted to unaddressed, and the sender gets
a one-shot reply saying so. This is where a refused *message* is refused —
including one sent with `send_targeted_message`, which posts either way and
reports `not_permitted` for that target. Only `delegate_task` refuses at the
sender. Agents created in Switch Console are **owner-only** by default: only
the Switch user who owns the agent may address it, which the owner can widen to
every agent they own. A human is recognised as the owner only when they
have claimed that messaging-app account as theirs; an unclaimed account never
matches, and the reply says as much rather than leaving them guessing.

Attachments carry a pointer, never bytes; fetch via the media endpoint.

### 6.3 `command`

```json
{ "command": "reset", "args": "", "user_id": "…", "user_name": "alice",
  "thread_id": "$root…" }
```

### 6.4 `room_join`

```json
{ "member": "@alice:switch.local", "member_name": "alice",
  "timestamp": 1785569372682, "listening": true }
```

`listening` reflects the per-room, per-agent opt-in. Under `filter: addressed`,
joins are delivered only when `listening` is true.

### 6.5 Task events

All five carry `task_id`, `requester_agent_id`, `performer_agent_id`, plus:

| type | extra |
|---|---|
| `task_delegate` | `summary`, `description` |
| `task_accept` | — |
| `task_update` | `update` |
| `task_finalise` | `outcome` |
| `task_cancel` | `reason` |

Task events are always notifiable and are delivered under both filters.

### 6.6 Control events

New, carried on the same stream:

| type | payload | meaning |
|---|---|---|
| `connection_state` | `connection_id`, `agent_id`, `scope`, `filter`, `spawn_capable`, `rooms`, `cursor`, `protocol`, `heartbeat_interval_seconds`, `server`, `client` | first event on every stream |
| `subscription_changed` | `rooms`, `reason` | scope changed — including a room going dark because another connection claimed it |
| `gap` | `from_sequence`, `resumed_at`, `reason` | events were dropped; re-read context. Carried to the agent on the next surfaced event, not as a wake of its own (§4.2) |
| `evicted` | `reason` | this connection lost its slot or was taken over; it must stop acting |

`gap` and `evicted` exist so that degradation is always visible. A client that
has missed events must never appear healthy.

**`connection_state` is where the server declares itself** (CHOO-1865). It is
the first frame of an already-authenticated stream, so no separate endpoint —
and no unauthenticated one — is needed:

```json
{
  "server": {
    "version": "0.12.3",
    "contracts": { "agent-protocol": { "speaks": 1, "accepts": 1 } }
  },
  "client": { "speaks": 1, "accepts": 1, "artifact": "agent-runtime", "version": "0.1.5" }
}
```

`server.version` is `null` when switch-core cannot read its own version. Null
means unknown and must be rendered as such, never as current. `db-schema` is
internal to switch-core and appears in no externally facing response.

`client` echoes back what the server understood the client to have said, with
`null` for anything it did not. A declaration that silently failed to parse is
worse than one never sent, because both sides believe it landed.

---

## 7. Operations (agent → server)

Every agent operation is reachable through **two front doors that dispatch into
one registry**:

- **MCP** — the tool surface an agent model calls.
- **HTTP** — `POST /agents/{agent_id}/ops/{operation}`, arguments as the JSON
  body, `X-Switch-Connection-Id` naming the caller's connection.

**Operation names are the MCP tool names verbatim.** A runtime translating
between the two is `POST /ops/${toolName}` and nothing more — no mapping table
to maintain, and no second vocabulary to keep in step.

Parity is **structural, not maintained**: operations live in a registry that
neither door owns. The HTTP endpoint dispatches into it; the MCP server
registers its tools from it. An operation is therefore reachable through both
doors the moment it exists, and **retiring a door is deleting a file** rather
than refactoring everything underneath. This is what makes a local runtime
possible at all (§9.1) and closes the overlap with CHOO-490.

An operation is a plain async function taking its arguments and nothing else.
Who is calling, and which connection or session they are bound to, comes from
a **call context** each front door establishes before dispatching — so no
transport type appears in an operation's signature, and the operations layer
imports nothing from either door.

`GET /agents/{agent_id}/ops` lists every operation and its JSON-schema
parameters, read straight off the registry.

### 7.1 What the caller supplies

An operation needs two things about its caller: **which agent** (the bearer
token) and **which session or connection** it belongs to. Over MCP the latter
is the transport session; over HTTP it is the connection id. Both are derived
by the server — from the credential and the header — never taken from the
request body.

A connection id belonging to a different agent, or to one that has died, is
**refused**, not silently treated as "no connection".

### 7.2 The operations

**Rooms** — `connect_to_room`, `read_context`, `list_participants`,
`list_rooms`, `list_all_rooms`, `get_room_detail`, `update_room`,
`create_room`, `archive_room`, `unarchive_room`, `invite_agent_to_room`,
`add_users_to_room`, `list_linked_rooms`, `link_rooms`, `unlink_rooms`,
`list_room_groups`, `create_room_group`, `get_room_group_detail`.

`connect_to_room` remains a single call that both subscribes and returns
instructions, participants, references, roles and linked rooms. Internally
subscription and payload are separate concerns; they are not split in the
agent-facing API, because an agent must not be able to subscribe to a room
without being told what the room is about.

**Messaging** — `post_message`, `send_targeted_message`.

**Tasks** — `delegate_task`, `accept_task`, `update_task`, `finalise_task`,
`cancel_task`, `list_tasks`.

**Roles** — `list_roles`, `get_role_detail`, `define_role`, `edit_role`,
`delete_role`, `assume_role`, `release_role`.

**Resources** — `list_references`, `list_reference_types`, `create_reference`,
`attach_reference_to_room`, `load_internal_documents`, `create_room_document`,
`update_room_document`, `delete_room_document`.

**Agents and bridges** — `list_agents`, `get_agent_detail`,
`update_agent_detail`, `list_bridges`.

### 7.3 What stays ordinary REST

Not agent operations, and shaped wrongly by RPC over JSON:

- **Media** — upload and download are multipart and binary.
- **The event stream** and **connection lifecycle** (`beat`, `subscribe`,
  `unsubscribe`) — these are the transport, not things done *through* it.
- **Mediation hooks**, **registration**, **runtime state**, **typing**.

## 8. Connection profiles replace agent profiles

`connection_model` is removed. What the server needs is observable from
connections; what it does not need was never its business.

| today | becomes |
|---|---|
| `always_on` | a connection with `scope: all` |
| `session_addressable` | a connection with `scope: single` |
| `auto_session` | a connection with `scope: all`, `spawn_capable: true` |
| `session_passive` | *no connection* — the agent can act, but receives nothing |

### 8.1 Statuses

Three, derived:

| status | condition |
|---|---|
| `LIVE` | a connection covers this room |
| `DORMANT` | no connection covers this room, but the agent has a live `spawn_capable` connection |
| `DISCONNECTED` | no connection covers this room |

`NO_SESSION` and `AWAITING_MANUAL_POLL` are removed: both describe what an
agent was *declared* to be, not what is true. The explanatory nuance humans
see ("this agent is started manually" vs "this agent is offline") moves into
the auto-reply text, read from the agent's configuration at reply time.

`DORMANT` currently renders with a blank emoji in `!status` — fixed here.

### 8.2 Role leases

The lease moves onto the connection.

- Keyed on the connection, not globally on the agent.
- Kept alive by the connection heartbeat; `/leases/renew` is removed.
- Released when the connection dies — for a reason, not on a timer.
- One role per connection replaces one role per agent, so an agent with two
  sessions may hold different roles in different rooms.

Leases still survive room hops, because the connection does.

---

## 9. MCP

MCP remains the tool surface. Two ways to reach it, converging on **one
connection object** — the stream registers it, calls validate against it, the
heartbeat maintains it, its death releases everything.

**Only the stream can create a connection.** Calls through either door attach
to one; they never conjure one "to be helpful", which would reintroduce two
things that can disagree.

**Switch hosting an MCP server is the legacy path.** It remains supported, but
the direction of travel is a local runtime (§9.1): MCP the *protocol* is how an
agent calls tools and is not going anywhere; Switch being the one to *host* it
is what recedes.

### 9.1 Local MCP (recommended)

One process holds the stream and serves MCP over stdio. A tool call arrives
**inside the process that owns the connection**, so correlation is a variable
in memory — nothing to transmit, leak or get wrong. The connection id never
appears in a prompt or a config file, and the process can refuse a tool call
immediately when its own stream is down.

**This is what ships now.** The runtime's source lives at
`console/packages/switch-agent-runtime`. It holds the stream, serves the whole
operation surface over stdio, and turns each tool call into
`POST /ops/{operation}` carrying its own connection id — so an agent never
talks to Switch directly and correlation is structural.

**Distribution is solved.** The runtime is published to npmjs as
`@sandboxaq/switch-agent-runtime`, and each plugin's bundled `.mcp.json` runs it
via `npx`. There is no copy of the runtime inside either plugin subtree, so the
second connector plugin cost nothing to add — which is why the original plan of
one copy per plugin was abandoned before the Codex plugin shipped.

The operation list is fetched from the server at startup rather than hardcoded,
so the tool surface is whatever the server actually offers. That surface is the
server's registry **plus** three tools the runtime serves itself:
`send_attachment`, `download_attachment`, and `select_agent` where the working
directory names more than one agent. If the fetch fails the runtime does not
refuse to start — it **degrades**, serving a single `switch_unavailable` tool
that reports why. Dying before the MCP handshake left the session with no
explanation at all, which is worse than an honest one-tool surface.

Planned second mode off the same code: *daemon* (long-lived, `scope: all`,
`spawn_capable`) alongside today's *session* mode (child of the agent,
`scope: single`).

Both hosts now register the server the same way — from the plugin's own bundled
`.mcp.json`, running the published runtime over `npx`. Neither needs a path
placeholder or `${VAR}` expansion, because the runtime resolves its own
credentials from `.switch/agents/` in the working directory rather than being
handed them in the config. The remaining difference is what the *host* adds:

- **Claude Code** — nothing beyond the plugin; the bundled `.mcp.json` is the
  whole registration.
- **Codex** — Switch Console writes a per-agent Codex profile
  (`$CODEX_HOME/<slug>.config.toml`, launched with `--profile <slug>`) carrying
  model, reasoning effort and instructions. It registers **no** MCP server; the
  plugin does that. An agent that specializes none of those three gets no
  profile at all.

### 9.2 Remote MCP (fallback)

Some hosts cannot run a local process — ChatGPT-style platforms require a
remote, publicly reachable HTTPS endpoint. They land on a reduced tier:

**Remote MCP with the agent's static token** — can act; holds no connection, no
room slot, no liveness, receives no pushed events. This is what `session_passive`
becomes, and it falls out of the model rather than being special-cased.

Correlating a remote MCP client to a stream is possible by minting a token per
connection and injecting it at launch, but that is deferred: it serves only the
fallback tier and costs minting, expiry, rotation and injection.

---

## 10. Client topologies

### 10.1 How a client knows which room a session is in

It asks; it does not observe.

Switch Console used to learn a session's room by watching: a `PostToolUse` hook
fired after `connect_to_room` succeeded and Switch Console recorded the room in its
own map, persisted to SQLite. The hook was accurate — the flaw was the *copy*. A
copy drifts when the session dies, when the connection fails after the tool
returned, when the server restarts, or when the room is deleted.

Under this design the session's own connection carries its subscription, and
that is authoritative. A client reads it from the local runtime it spawned
(same process as the connection) or from Switch. **The hook, the persisted
session→room blob, and the remote mirror all go away.**

*State of the migration.* Switch Console now opens the stream itself and hands the
session `SWITCH_CONNECTION_ID`, so a Switch Console-launched session claims its room
on a connection Switch Console already holds — for Claude Code and for Codex alike.
The `PostToolUse` hook survives only as the fallback for a **Claude** session
Switch Console did not start and adopted afterwards, which holds a connection of its
own. Codex registers no such hook. Since the Codex connector plugin now ships
the Switch MCP server, a Codex session Switch Console did not start *can* call
`connect_to_room`; such a session is currently untracked rather than impossible.

Cross-checking a room against incoming events becomes unnecessary: a
connection only receives events for rooms it is subscribed to, and any change
— including a room going dark because another connection claimed it — arrives
as `subscription_changed`.

### 10.2 One connection per session, or one per agent

A connection is a socket, and a socket belongs to one process. Two terminal
sessions are two processes and therefore two connections; the count follows
from the topology, not from policy.

**Default: one connection per session.** A spawned session opens its own
`single`-scope connection; the daemon holds an `all`-scope one and only
notices uncovered rooms and spawns. This is the shape that already exists, it
isolates failure (the daemon dying does not disconnect running sessions), and
it keeps correlation structural.

**Optional later: one connection per agent.** A daemon may multiplex sessions
behind a single connection, serving them a local MCP endpoint and minting a
per-session token at spawn so it knows which session is calling. Switch does
not change: it sees one `all`-scope connection either way, and reachability
questions are answered from scope. This is a client-side optimisation, not a
protocol migration — but nothing else should hard-code one-socket-per-session
assumptions.

## 11. Backward compatibility

Polling clients must keep working. Both paths read the **same buffer**, so they
cannot diverge while both exist.

The old poll endpoint sends no cursor, so **the server keeps one on its
behalf**: "everything after the last thing I gave you, and record that I gave
it." Behaviour is unchanged for the old client — it polls, gets new events,
never sees a duplicate — but events are no longer destroyed for anyone else.

Two consequences, stated rather than hidden:

- Old clients keep **at-most-once** delivery, as today: the server advances the
  cursor on send, so a lost response loses those events. New clients get
  **at-least-once**, because they confirm.
- An old client that restarts has no cursor and cannot ask what it missed. It
  resumes wherever the server's cursor sits. Left honestly broken; the fix is
  to migrate the client.

`SWITCH_CHANNEL_DISABLE_POLL` was expected to be deletable once reads became
non-destructive. It was not deleted — it was **repurposed**, keeping the name
for compatibility. It no longer stops a second poll (there is no poll to steal);
it suppresses *notification surfacing* in the runtime, so a session whose events
Switch Console already delivers into the pane does not also receive them as MCP
notifications. Same variable, different problem: double delivery, not double
poll.

Polling endpoints are removed in a later, separate release.

---

## 12. Failure handling

Fail loud, never fake. Concretely:

| situation | behaviour |
|---|---|
| resume from a cursor older than the buffer | error: missed events, re-read context |
| buffer overflow | drop oldest, flag gap, `gap` event on next connection; client attaches it to the next event it surfaces |
| heartbeat with no stream attached | reject: reopen the stream |
| call with unknown/dead `connection_id` | reject: reconnect and resume |
| `connection_id` belonging to another agent | reject |
| room slot already claimed | reject, naming the incumbent — except `connect_to_room`, which takes over and reports what it evicted |
| slot taken over | incumbent's rooms change; it receives `subscription_changed` and goes dark on that room |
| server restart | cursors invalidated; clients told to re-read |
| non-overlapping protocol ranges | refuse at open; the 409 body carries both ranges and names which side is behind |
| client declares no protocol range | record as unknown and admit — unknown is not incompatible |
| per-agent connection cap exceeded | reject loudly |

A connection that has silently missed events must never appear healthy.

---

## 13. Delivery plan

**Stage A — server plus one client.** *(implemented)*

1. Sequence numbers on events; bounded buffer with gap flag; old poll
   endpoints served from the buffer with a server-held cursor. No client
   changes.
2. Connection object, SSE endpoint, heartbeat, scope, filter, slots, the state
   machine of §5.3. Polling still works. Testable with `curl`.
3. Claude Code connector on the stream: connection id, resume by cursor, one
   heartbeat, room claimed on the connection.

4. HTTP operations front door (§7): every MCP tool reachable at
   `POST /ops/{operation}`, dispatched from the same registry so parity cannot
   drift. Unblocks the local runtime and closes the overlap with CHOO-490.

   **The two MCP servers are merged into one local runtime.** *(implemented)*
   `@sandboxaq/switch-agent-runtime` serves the tool surface over stdio —
   fetched from the server at startup, so it cannot drift — and translates each
   call to `POST /ops/${toolName}` on its connection. Each connector plugin now
   registers exactly one MCP server (`switch`); the separate remote `switch` and
   local `switch-channel` pair is gone.

**Stage B — migrate the clients. Nothing is removed.**

The server stays backward compatible until the clients are known to have moved,
so everything here is additive: a client still polling and still sending the
three renews is unaffected and unaware.

4. **Presence is the union of the heartbeat rows and the live connections.**
   *(implemented)* Presence was read only from `agent_sessions` and
   `role_leases` — the rows the pre-connection clients kept warm with
   `/connection/renew`, `/watch/heartbeat` and `/leases/renew`. A client on the
   single connection heartbeat sends none of those, so it would show
   DISCONNECTED and lose its role within six seconds of migrating, while alive
   on its stream. That, not the transport, is what blocks the client work.

   Every reader now takes both arms:

   | reader | connection arm |
   |---|---|
   | `compute_agent_statuses` | `live_agents` / `live_agents_in_room` OR-ed into each liveness set |
   | `AgentClient._is_available` | a covering connection means reachable |
   | `AgentClient` "sessions elsewhere" / `bound_here` | connection rooms merged with the bound rooms |
   | `auto_session` spawn reply | any live connection counts as watching |
   | `room_role_store` (6 predicates + `acquire_lease`) | `last_seen_at` fresh **OR** `agent_id` in `alive_agent_ids` |
   | `assemble_agent_detail` | connections listed as sessions, `lifecycle: "connection"` |

   Neither arm alone is correct while both kinds of client exist. Stage C
   deletes the DB arm and what remains is this code minus one branch — which is
   why the union goes in now rather than a write-shim that would be thrown away.

   `connections` is a **required** argument on `compute_agent_statuses` and
   `assemble_agent_detail`: a call site that forgot it would report a migrated
   agent as offline, and nothing at the call site would show it. Pass an empty
   registry to mean "DB arm only". The store-level predicates default
   `alive_agent_ids` to empty, since the store is a query layer with no registry
   to hand and its own tests exercise the freshness rule directly.

   One registry is created in `main.py` and injected into `AgentClient`,
   `AdminClient` and the bridge app — the Matrix clients are wired before the
   bridge, so the bridge could no longer own it.

5. *(implemented)* Switch Console (`RoomConnection` → session-grained connection
   that repoints rooms; daemon mode) and the sidecar, which reuses the same
   class verbatim — `sidecar-runtime.ts` constructs `RoomConnection` directly,
   so the two migrated together rather than separately. The `auto_session`
   watcher's `/notifications` poll folded into an `all`-scope connection, and
   its three heartbeat loops collapsed into one beat.

   `RoomConnection` resumes from a cursor; the pre-migration poll did not.

**Stage C — the removals. Gated on the clients having transitioned.**

6. Remove `connection_model`; derive statuses from connections alone; move role
   leases onto the connection; delete the three renew endpoints and the DB arm
   of every union above.
7. Remove the polling endpoints.

Opportunistic, relevant to this work: the `DORMANT` display bug.
`read_context`'s deep-history pagination is **done** (CHOO-2034) — it follows
Matrix's continuation token, pages backwards for `before`, and reports
`truncated` when it stops short, which matters now that "re-read context" is
the documented recovery path for a gap.

Both connector skills (`claude-code-plugin`, `codex-plugin`) and both plugin
versions must be updated when the agent-facing contract changes.

---

## 14. Related work

- **CHOO-490** — HTTP protocol parity. Delivered: the operation surface has an
  HTTP front door (`GET /agents/{id}/ops`, `POST /agents/{id}/ops/{operation}`)
  serving the same registry as MCP.
- **CHOO-1810** — two notification builders. §2.3 shipped, but this is **not**
  closed: both builders still exist, and `GET /agents/{id}/notifications` is
  still a live route.
- **CHOO-1685** — AG-UI. Being worked separately rather than here; the event
  envelope is versioned and additive so it stays landable.
- **CHOO-1101 / CHOO-1366 / CHOO-1811** — bugs caused by the polling model.
  Useful as tests of whether this design makes them impossible rather than
  merely fixed.
