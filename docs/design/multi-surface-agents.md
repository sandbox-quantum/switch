# Multi-surface agents

**Status:** design
**Scope:** agent protocol (connections, operations), collaboration bridges (email)

## User story

> As someone who works across several messaging platforms, I want **one agent I
> can reach from any of them**, so that I do not have to re-explain context to a
> different assistant on each surface.
>
> I forward an email to my agent. Later, in a Slack channel, I ask about it — and
> it answers, without my having to paste the email or say which one I mean. When
> it replies, it replies on the surface I am asking from. When something needs to
> go back to the email correspondent, it goes out as email.

One agent identity, one context, several surfaces. Concretely:

1. The agent is reachable at an email address and present in a Slack channel.
2. An email sent to that address reaches the agent.
3. A message in the Slack channel reaches the *same* agent, with the email
   already in its context — no re-statement, no lookup by the human.
4. The agent replies into whichever surface the request arrived on.
5. It can also reply on the *other* surface when that is the right destination.
6. Events from both surfaces are ordered consistently with each other, so the
   agent can reason about what happened before what.

### Non-goals

- **Sending email to an arbitrary new address.** "Reply through email" here means
  replying into an existing email conversation the agent is party to. Composing
  to a stranger is a separate capability with its own authorization question.
- **Merging surfaces into a single room.** See *Rejected alternatives*.
- **SMS, WhatsApp, and other transports.** They fit the same shape; email is the
  one being built.

## Why this does not work today

The pieces are closer than they look. Rooms already model surfaces, and the event
buffer is already per-agent and room-tagged. Five things block it.

### 1. A multi-room connection can receive but cannot act

`require_connected_room()` (`core/switch_core/bridges/agent/operations/context.py`)
raises when a connection covers more than one room:

> "This connection covers several rooms; the operation needs one — pass the room
> explicitly or use a single-room connection."

No operation accepts a room. 22 call sites in
`core/switch_core/bridges/agent/operations/definitions.py` go through this
function. Delivery to a multi-room connection works; every action fails.

### 2. There is no scope for "these rooms"

`Scope = Literal["single", "all"]`
(`core/switch_core/bridges/agent/protocol/connections.py`). `single` clears the
room set on each claim; `all` leaves it empty and covers everything unclaimed.
Neither expresses "I work in this declared set of rooms."

`Connection.rooms` is already a `set[str]`, and `claim_room()` only special-cases
`single`. The data model is multi-room already; the type is what forbids it.

### 3. Events name a room but not a surface

The envelope carries `room_id`. `room_name` is documented in
`docs/old/api/AGENT_PROTOCOL.md` §6.1 as *"proposed, not implemented"*, with the
stated reason being exactly this case — "`all`-scope clients receive events for
rooms they never explicitly connected to."

An agent holding two surfaces in one context window needs to tell them apart to
reason about them and to choose a reply target. A UUID does not do that.

### 4. Two `all`-scope connections on one agent duplicate delivery

`covers()` returns true for an `all` connection whenever no sibling has *claimed*
the room — and an `all` connection never claims. So two of them both cover
everything, and `stream.py` delivers to both. `holder_of()` returns whichever
comes first in iteration order.

This matters because Switch Console's auto-session-watcher already holds an
`all`-scope connection per agent
(`console/apps/switch-console-desktop/src/main/core/switch-rooms/auto-session-watcher.ts`).
A second `all` connection for a persistent agent would collide with it — and
worse, the watcher would spawn a `single`-scope session on the first addressed
message, claiming the room and going dark on the persistent agent that holds the
context.

### 5. There is no email bridge

`core/switch_core/bridges/collaboration/` has Slack, Mattermost, Discord, Teams
and Telegram. No email.

## Design

### Rooms stay one-per-surface

A room continues to map to at most one bridge and one external channel. A Slack
channel is a room; an email correspondent is a room. **Unification happens at the
connection layer, not in the room.**

```
Agent (one Matrix identity, one row in `agents`)
  └── session (one process, one context window — invisible to Switch)
        └── connection, scope: multi
              ├── room A  ──bridge──▶  Slack channel
              └── room B  ──bridge──▶  email correspondent
```

This is what makes the change small: no schema migration, no fan-out policy, and
no new disclosure surface. It also means the agent always knows which surface it
is replying to, because rooms and surfaces are 1:1.

### A third scope: `multi`

| scope | rooms | topology |
|---|---|---|
| `single` | exactly one, claimed | a session in a room |
| `multi` | an explicit set, all claimed | an agent working across declared surfaces |
| `all` | everything unclaimed, dynamic | a supervisor that watches and spawns |

`multi` claims each of its rooms, which means the existing room-slot invariant —
*at most one connection per (agent, room) may act as that agent in that room* —
does the coordination for free:

- The watcher's `all` connection goes dark on precisely the claimed rooms and
  keeps covering everything else.
- `claimant_of()` returns exactly one connection per room, so `holder_of()` is
  deterministic and blocker #4 does not arise.

No per-agent "runtime mode" flag is needed. Note that
`integration_profile.connection_model` (`always_on`, `session_addressable`,
`auto_session`, `session_passive`) is the declared-form ancestor of this idea and
is already slated for removal in favour of scope observed on the connection
(AGENT_PROTOCOL §8). `multi` fits where that table is heading rather than adding
a parallel mechanism.

### Ordering comes free

`EventBuffer.enqueue(agent_id, room_id, event)` assigns from a single sequence per
agent and appends to one deque, with `room_id` as a tag. A single connection
reading that log gets total ordering across every surface with no extra work.
This is the concrete reason to prefer one multi-room connection over several
single-room ones: N sockets re-merged by arrival time lose it.

## Changes

Two independent tracks. The protocol work is an architecture change; the email
bridge is new code against a seam that does not move.

### Track A — protocol

**A1. Room-addressed operations.** *(the load-bearing change)*

Add an optional `room_id` to the room-scoped operations in `definitions.py`.
Resolution moves into `require_connected_room(room_id=None)`:

- omitted, connection covers one room → that room (today's behavior, unchanged)
- omitted, connection covers several → error naming the ambiguity
- supplied → must be in `conn.rooms`, else a clean error

`definitions.py` is the single registry behind both the MCP server and the HTTP
front door, so this lands on both at once. It is a public tool-surface change,
so the three connector skills under `connectors/*/skills/switch/SKILL.md` must
be updated together. Note that `test_mcp_tool_surface.py` checks tool *names*
against each skill's `## Tool index` and that all three index the same set — it
will not catch a new parameter documented on only one host, so diff the skills
against each other after editing.

This also gives `read_context(room_id=...)`, which is what makes gap recovery
well-defined for a multi-room connection (see *Open questions*).

**A2. `Scope` gains `"multi"`.**

Add the literal; change `covers()` so the explicit-set branch applies to
everything that is not `all`. `claim_room()` already accumulates for any
non-`single` scope, so claiming needs no change.

**A3. `room_name` on the event envelope.**

Implement what §6.1 already specifies. Small, and it is what lets an agent
reason in terms of surfaces rather than UUIDs.

**A4. Membership-change notification.**

The one capability `multi` lacks relative to `all`: a `multi` connection receives
nothing for rooms it has not claimed, so nothing tells it that the agent was just
added to a new room. Without this, a room can be created and the agent silently
never speaks in it.

Most naturally a control event on the existing stream — extending
`subscription_changed`, or a sibling event reporting membership changes outside
the claimed set.

**A5. Reject a second `all` connection per agent.**

A backstop for blocker #4. With `multi` in place the collision should not happen,
but the current failure is silent duplicate delivery plus a nondeterministic
holder, which is precisely the kind of thing that should fail loudly instead.

### Track B — email bridge

**B1. The adapter.** A new `core/switch_core/bridges/collaboration/email/`
implementing `CollaborationAdapter`, plus an `EmailConnectionConfig`, registered
with one line in `core/switch_core/main.py`.

No frontend work: `GET /types` builds the operator form from the config class's
JSON schema, and nothing in `gateway/src` names a bridge type.

Class-level declarations, all of which the ABC already supports:

- `supports_channel_creation = False`
- `supports_directory_search = False`
- `renders_custom_url_schemes = False`
- `send_typing` is a no-op, so the default runtime-state handling never emails a
  "working on it" status
- `update_message` / `delete_message` raise — email is append-only. The only live
  call site is an unwired protection-verdict path.

Inbound arrives by provider webhook over the adapter's own HTTP listener, the way
Teams does, with `exclusive_resource()` returning the port so a collision is
refused at registration rather than dying in a background task.

**B2. Inbound parsing.** The genuinely uncertain part, and where the estimate is
softest:

- **Forward unwrapping** — on a forwarded message the envelope sender is the
  forwarder and the content sender is the original correspondent. Recovering the
  original `From`/`Subject`/`Date` has no cross-client standard.
- Quoted-history and signature stripping, or every turn re-feeds the whole thread.
- MIME and HTML to text/markdown.
- Loop protection: honour `Auto-Submitted:`, `List-*`, `Precedence: bulk`. An
  autoresponder must not produce an infinite exchange.
- Attachment relay through the existing `Attachment` model, bounded by
  `_max_attachment_bytes`.

**B3. Outbound.** SMTP or provider API, setting `In-Reply-To`/`References` so
replies thread in the recipient's mail client. `translate_outbound` renders
Switch markdown to multipart HTML.

**B4. Room mapping.** Email rooms are `channel_type="direct"`, which means every
message addresses the agent — no `@mention` convention to invent.
`_create_room_for_channel` already has the `direct` branch, so auto-creation is
existing behavior.

### Track C — client

**C1. A `multi`-scope, long-lived client.** `bin.ts` hardcodes `scope: 'single'`.
Scope and filter become options, and something has to hold the connection open
across restarts and rehydrate its working state.

Track C depends on A1 and A2. It is listed separately because it lives in
`console/` and is the piece most likely to change shape once A is real.

## Rejected alternatives

**One room mapped to several surfaces.** Would require replacing
`Room.bridge_id` / `Room.external_channel_id` with a join table, and unique index
`uq_rooms_bridge_external_channel` with it. Rejected not for the migration cost
but because outbound has no safe default: with several bridges attached, every
message the agent posts fans out to all of them, so internal discussion reaches an
external correspondent. It also breaks room membership as the answer to "who can
see what". And it saves nothing — the agent must still name a target surface per
message.

Worth building later for a different purpose: a room whose point is cross-platform
*human* conversation (a Slack channel and a Teams channel as one discussion),
where fan-out to all attached surfaces is the desired behavior.

**Several single-room connections behind one session.** Works today with no server
change — one MCP server process per connection, since `SWITCH_CONNECTION_ID` is
read from the environment. Useful as a prototype. Rejected as the end state: it is
fixed at config time, multiplies the tool surface by the number of surfaces,
loses cross-surface ordering, and still requires the model to disambiguate — by
server name rather than by room id, which is a second naming scheme it has to map
onto rooms itself.

**Scope `all` for the working connection.** Collides with the watcher (blocker
#4), and makes the agent's context "every room anyone has ever added it to"
rather than a declared set.

## Open questions

1. **Gap recovery for a multi-room connection.** The buffer is capped per agent;
   overflow flags a gap whose prescribed response is "re-read room context". For
   a `multi` connection that means re-reading *which* rooms? A1 makes
   `read_context(room_id=...)` possible; the policy still needs deciding — most
   likely re-read every claimed room, which is bounded because the set is
   explicit.

2. **Does a `multi` connection auto-claim, or claim explicitly?** Declaring the
   room set at open is one round trip; N `connect_to_room` calls is consistent
   with today's flow and composes with A4. Leaning explicit.

3. **Context strategy for a long-lived agent.** Interleaved surfaces accumulating
   for weeks in one window. Room labelling per event is necessary; a durable
   external artifact (a room document) as the working state, with the context
   window as scratch, is the likely answer. Belongs to Track C.

4. **Reply-surface default.** When the agent acts unprompted rather than in
   response to an event, which room does it speak in? Probably explicit — no
   default — but that should be a deliberate decision rather than an accident of
   `require_connected_room`'s fallback.
