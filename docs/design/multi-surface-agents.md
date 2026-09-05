# Multi-surface agents

**Status:** design
**Scope:** agent protocol (connections, operations, scheduling), collaboration
bridges (email, sender authenticity), room disclosure labelling

## The shape of it

One agent identity, reachable on several messaging surfaces, holding one context
across them, replying on whichever surface fits — and knowing which things it may
carry from one surface to another.

The last clause is not an afterthought. Unifying context is the easy half; the
hard half is that a unified context can say the wrong thing in the wrong room.

## User stories

### US-1 — One agent, several surfaces

> As someone who works across several messaging platforms, I want **one agent I
> can reach from any of them**, so that I do not have to re-explain context to a
> different assistant on each surface.

I forward an email to my agent. Later, in a Slack channel, I ask about it — and it
answers, without my pasting the email or saying which one I mean. It replies on
the surface I am asking from.

### US-2 — Pick up where I left off, somewhere else

> As someone who moves between places during the day, I want to continue a
> conversation on a different surface than I started it on, so that walking away
> from my desk does not mean starting over.

Three rounds deep in Slack about a proposal, I leave. From the car I text *"make
it three sections, not five"* — and it knows what "it" is.

### US-3 — Let the agent choose how to reach me

> As someone who already gets too many notifications, I want my agent to pick the
> channel that fits what it is telling me, so that "urgent" and "FYI" do not
> arrive the same way.

Routine progress appears quietly in the team channel. A decision needed within the
hour arrives as a text. Something needing a record goes out as email. And it does
not text me at 11pm about something that could have waited.

### US-4 — Know what to repeat and what to keep to myself

> As someone who tells my agent things privately, I want it to **use** what I told
> it without **repeating** it, so that I can be candid without worrying where it
> ends up.

I privately tell it I think a vendor's pricing will be a problem at renewal. Later
someone asks about that renewal in the team channel. The answer is shaped by what
it knows, without saying that I said it.

Both failure modes are real: quoting the DM in the channel, and — over-corrected —
pretending not to know and giving a visibly worse answer.

### US-5 — Let someone outside work with my agent on their terms

> As someone who works with people outside my company, I want them to reach my
> agent through the one channel they actually have, without getting them an
> account, while I follow it from where I already work.

A vendor emails the agent a revised quote with a question. The agent answers them
by email. I follow it from my team channel and only step in for the decision that
is mine.

### US-6 — Be recognised as me, wherever I am

> As someone with a work laptop, a personal phone and several addresses, I want my
> agent to know it is me whichever one I use — and **not** to be fooled by someone
> claiming to be me.

I forward something from my personal address while travelling and it is treated as
mine. An address it has never seen asks it to send a document "on my behalf", and
it does not.

### Non-goals

- **Composing email to an arbitrary new address.** "Reply by email" here means
  replying into a conversation the agent is already party to. Cold outbound is a
  separate capability with its own authorization question.
- **Merging several surfaces into one room.** See *Rejected alternatives*.
- **A proof of non-disclosure.** US-4 is addressed with labelling, instruction and
  an auditable egress check. Paraphrase defeats any text-matching rule, so the
  guarantee is bounded and stated as such in *Track D*.

## Why this does not work today

Rooms already model surfaces, and the event buffer is already per-agent and
room-tagged. Seven things block the stories above.

### 1. A multi-room connection can receive but cannot act

`require_connected_room()`
(`core/switch_core/bridges/agent/operations/context.py`) raises when a connection
covers more than one room:

> "This connection covers several rooms; the operation needs one — pass the room
> explicitly or use a single-room connection."

No operation accepts a room. 22 call sites in
`core/switch_core/bridges/agent/operations/definitions.py` go through it.
Delivery to a multi-room connection works; every action fails.

### 2. There is no scope for "these rooms"

`Scope = Literal["single", "all"]`
(`core/switch_core/bridges/agent/protocol/connections.py`). `single` clears the
room set on each claim; `all` leaves it empty and covers everything unclaimed.
Neither expresses "I work in this declared set."

`Connection.rooms` is already a `set[str]` and `claim_room()` only special-cases
`single`. The data model is multi-room already; the type forbids it.

### 3. Events name a room but not a surface

The envelope carries `room_id`. `room_name` is documented in
`docs/old/api/AGENT_PROTOCOL.md` §6.1 as *"proposed, not implemented"*, with the
stated reason being exactly this case. An agent holding two surfaces in one
context window needs to tell them apart; a UUID does not do that.

### 4. Two `all`-scope connections on one agent duplicate delivery

`covers()` returns true for an `all` connection whenever no sibling has *claimed*
the room — and an `all` connection never claims. Two of them both cover
everything, and `stream.py` delivers to both; `holder_of()` returns whichever
comes first in iteration order.

Switch Console's auto-session-watcher already holds one `all` connection per agent
(`console/apps/switch-console-desktop/src/main/core/switch-rooms/auto-session-watcher.ts`).
A second would collide — and worse, the watcher spawns a `single` session on the
first addressed message, claiming the room and going dark on the persistent agent
that holds the context.

### 5. Nothing wakes an agent that has not been spoken to

There is no scheduler in core. Every agent turn today is a response to an inbound
event. US-3 needs an agent that acts at a time of its own choosing.

### 6. There is no way to reach a *person*, only a room

The agent can post into rooms. Choosing to text someone means resolving person →
their surfaces → a room on the right bridge. `ExternalUserClaim`, `create_room`
and the adapters' `create_dm_channel` all exist; nothing composes them, and
nothing records how a person prefers to be reached.

### 7. Unified context has no confidentiality model — and today's isolation is accidental

Session-per-room currently gives **accidental isolation**: the session answering
in a team channel never saw the private DM, so it cannot leak it. That is not a
designed protection, but it is a real one, and the `multi` connection dissolves
it deliberately.

After this change the only thing between a private DM and a public channel is the
model's judgment inside one context window. **This design must not ship the
unification without the disclosure story**; see *Sequencing*.

### 8. Email introduces an unauthenticated sender

Every existing bridge sits behind a platform that authenticated the sender: when
Slack says a message is from `U123`, it is. **Email `From` is forgeable by
anyone.** Combined with owner-scoped addressing policies
(`core/switch_core/addressing.py`), a forged `From` is privilege escalation into an
agent that acts on the owner's behalf — not spam.

## Design

### Rooms stay one-per-surface

A room continues to map to at most one bridge and one external channel. A Slack
channel is a room; an email correspondent is a room. **Unification happens at the
connection layer, not in the room.**

```
Agent (one Matrix identity, one row in `agents`)
  └── session (one process, one context window — invisible to Switch)
        └── connection, scope: multi
              ├── room A  ──bridge──▶  Slack channel     [restricted]
              ├── room B  ──bridge──▶  email correspondent [external]
              └── room C  ──bridge──▶  Slack DM          [private]
```

No schema migration for the room→surface mapping, no fan-out policy, and the
agent always knows which surface it is replying to because rooms and surfaces are
1:1.

### A third scope: `multi`

| scope | rooms | topology |
|---|---|---|
| `single` | exactly one, claimed | a session in a room |
| `multi` | an explicit set, all claimed | an agent working across declared surfaces |
| `all` | everything unclaimed, dynamic | a supervisor that watches and spawns |

`multi` claims each of its rooms, so the existing room-slot invariant — *at most
one connection per (agent, room) may act as that agent in that room* — does the
coordination for free. The watcher's `all` connection goes dark on precisely the
claimed rooms; `claimant_of()` returns exactly one connection per room, so
blocker #4 does not arise.

No per-agent "runtime mode" flag is needed.
`integration_profile.connection_model` is the declared-form ancestor of this idea
and is already slated for removal in favour of scope observed on the connection
(AGENT_PROTOCOL §8); `multi` fits where that table is heading.

**An important property falls out:** because the claimed set is explicit,
declining to unify is always available. An operator who wants hard isolation
between a private DM and a public channel simply does not span them on one
connection. That is the strongest guarantee on offer, it costs nothing, and
Track D is what makes the *spanned* case tolerable rather than the only option.

### Ordering comes free

`EventBuffer.enqueue(agent_id, room_id, event)` assigns from a single sequence per
agent and appends to one deque. A single connection reading that log gets total
ordering across every surface — including scheduled wake-ups (Track E), which
enter the same log. This is the concrete reason to prefer one multi-room
connection over several single-room ones.

### Disclosure: label the rooms, tell the agent, check the egress

Three layers, weakest to strongest, because no single one is sufficient:

1. **Every room carries an audience label**, defaulted from `channel_type` so the
   common case needs no configuration.

   | label | meaning | default from |
   |---|---|---|
   | `private` | one human and the agent | `direct` |
   | `restricted` | a named, closed group | `channel_private`, `group` |
   | `open` | anyone in the workspace | `channel_public`, `lobby` |
   | `external` | includes people outside the organisation | any room whose correspondent is external |

   `private < restricted < open` is an ordering. `external` is **orthogonal**: an
   email room with a single vendor in it is tiny but outside the trust boundary.

2. **The agent sees the label on every event and is given the flow rule.** Content
   may move into a room of equal or narrower audience. Moving it into a wider or
   `external` room requires explicit authorization from a human *in that turn*.
   A model cannot be discreet about a boundary it cannot see, so this layer is
   the prerequisite for the other two rather than an alternative to them.

3. **Rooms may opt into an egress check.** `Room.protection_config` already
   exists, and `handle_protection_verdict` in `bridge_core.py` can already edit or
   delete a relayed message — currently behind `# TODO: use this when protection
   setup is done`. That is the enforcement seam.

**What this does and does not guarantee.** It makes the boundary visible to the
model, makes crossings auditable, and lets a sensitive room enforce a check
before relay. It does **not** make leakage impossible: paraphrase defeats any
text-level rule. Stated plainly here so nobody reads the feature as a proof.

### Authenticity is a property of an inbound message, not an assumption

`CollaborationAdapter` gains a class-level `authenticates_senders: ClassVar[bool]
= True`, matching the existing idiom of `supports_channel_creation` and
`supports_directory_search`. Every current adapter inherits `True`. Email sets it
`False` and supplies per-message verification instead.

`InboundMessage` gains an authenticity result. The addressing layer requires an
authenticated sender before any owner-scoped rule can match, so unverified mail
cannot impersonate the owner. Refusal is visible, not a silent downgrade.

## Changes

Five tracks. A, D and E are protocol/architecture; B is new code against a seam
that does not move; C is the client.

### Track A — protocol core

**A1. Room-addressed operations.** *(load-bearing)*

Add an optional `room_id` to the room-scoped operations in `definitions.py`.
Resolution moves into `require_connected_room(room_id=None)`:

- omitted, connection covers one room → that room (today's behaviour, unchanged)
- omitted, connection covers several → error naming the ambiguity
- supplied → must be in `conn.rooms`, else a clean error

`definitions.py` is the single registry behind both the MCP server and the HTTP
front door, so this lands on both at once. It is a public tool-surface change, so
the three connector skills under `connectors/*/skills/switch/SKILL.md` must be
updated together. Note `test_mcp_tool_surface.py` checks tool *names* against each
skill's `## Tool index` and that all three index the same set — it will not catch
a new parameter documented on only one host, so diff the skills against each other
after editing.

This also gives `read_context(room_id=...)`, which makes gap recovery well-defined
for a multi-room connection.

**A2. `Scope` gains `"multi"`.** Add the literal; change `covers()` so the
explicit-set branch applies to everything that is not `all`. `claim_room()`
already accumulates for any non-`single` scope.

**A3. `room_name` and the audience label on the event envelope.** Implement what
§6.1 already specifies, and carry the Track D label alongside it. An agent cannot
apply the flow rule to an event whose room it cannot characterise.

**A4. Membership-change notification.** The one capability `multi` lacks relative
to `all`: it receives nothing for rooms it has not claimed, so nothing tells it
the agent was added to a new room. Most naturally a control event on the existing
stream — extending `subscription_changed`, or a sibling reporting membership
changes outside the claimed set.

**A5. Reject a second `all` connection per agent.** Backstop for blocker #4. The
current failure is silent duplicate delivery plus a nondeterministic holder, which
should fail loudly instead.

### Track B — email bridge

**B1. The adapter.** A new `core/switch_core/bridges/collaboration/email/`
implementing `CollaborationAdapter`, plus an `EmailConnectionConfig`, registered
with one line in `core/switch_core/main.py`. No frontend work: `GET /types`
builds the operator form from the config class's JSON schema, and nothing in
`gateway/src` names a bridge type.

Class-level declarations, all already supported by the ABC:
`supports_channel_creation = False`, `supports_directory_search = False`,
`renders_custom_url_schemes = False`, and (new, from Track A/D)
`authenticates_senders = False`. `send_typing` is a no-op so the default
runtime-state handling never emails a "working on it" status.
`update_message` / `delete_message` raise — email is append-only, and the only
live call site is an unwired protection-verdict path.

Inbound arrives by provider webhook over the adapter's own HTTP listener, the way
Teams does, with `exclusive_resource()` returning the port so a collision is
refused at registration rather than dying in a background task.

**B2. Inbound parsing.** The genuinely uncertain part:

- **Forward unwrapping** — on a forwarded message the envelope sender is the
  forwarder and the content sender is the original correspondent. Recovering the
  original `From`/`Subject`/`Date` has no cross-client standard.
- Quoted-history and signature stripping, or every turn re-feeds the whole thread.
- MIME and HTML to text/markdown.
- Loop protection: honour `Auto-Submitted:`, `List-*`, `Precedence: bulk`.
- Attachment relay through the existing `Attachment` model, bounded by
  `_max_attachment_bytes`.

**B3. Sender authentication.** *(security-relevant — see blocker #8)* Evaluate
SPF/DKIM/DMARC, mostly available as headers or provider-supplied fields, and
attach the result to the inbound message. Unauthenticated mail satisfies no
owner-scoped addressing rule and is refused with a stated reason.

**B4. Outbound.** SMTP or provider API, setting `In-Reply-To`/`References` so
replies thread in the recipient's client. `translate_outbound` renders Switch
markdown to multipart HTML.

**B5. Room mapping.** Email rooms are `channel_type="direct"`, which means every
message addresses the agent — no `@mention` convention to invent.
`_create_room_for_channel` already has the `direct` branch. Their audience label
defaults to `external`.

### Track C — client

**C1. A `multi`-scope, long-lived client.** `bin.ts` hardcodes `scope: 'single'`.
Scope and filter become options, and something holds the connection open across
restarts and rehydrates working state. Depends on A1 and A2.

**C2. Surface labelling in context.** Every event the client surfaces to the model
carries its room name and audience label. This is the client half of Track D
layer 2 — the labels are useless if the context window flattens them away.

**C3. Durable working state.** A long-lived agent should not depend on its context
window surviving for weeks. Room documents (`create_room_document` /
`update_room_document`, already in `definitions.py`) are the natural store, and
give a restart something to rehydrate from other than full room history.

### Track D — disclosure control

**D1. Room audience labels.** A column on `rooms` with the defaults derived from
`channel_type` in the table above, overridable per room, exposed on the room
surfaces and in the envelope (A3).

**D2. The flow rule in room instructions.** Rooms already carry `instructions`.
The rule is stated to the agent as part of its standing context, alongside the
per-event labels.

**D3. Egress check.** Wire `handle_protection_verdict` for rooms that opt in via
`protection_config`. Bounded scope: an outbound post to a room labelled wider than
the material it draws on is checked before relay, and refusal is visible in the
room rather than silent.

**Sequencing.** D1 and D2 must land **with or before** the first `multi`
connection that spans rooms of differing labels. D3 can follow. Shipping A1+A2
alone across a private DM and a shared channel is a regression against today's
accidental isolation.

### Track E — proactive agency

**E1. Scheduled wake-ups.** An operation to register a future or recurring
wake-up, and a server-side scheduler that enqueues a `timer` event into the
per-agent buffer when it is due.

Server-side rather than a client timer, because the point is durability: a client
timer dies with the process, and an agent whose whole value is remembering the
Thursday review must survive a restart. Delivering it as an ordinary buffered
event also means it is ordered against real traffic for free, and needs no new
transport.

**E2. Surface directory.** Resolve a person to the surfaces that reach them —
their `ExternalUserClaim` rows, each on a bridge, with what that bridge can do.
Read-only; the agent chooses.

**E3. Reach a surface.** Given a person and a chosen surface, resolve-or-create
the direct room and return it. Composes `create_room` with the adapters'
`create_dm_channel`. This is what turns "I should text her" into a room the agent
can post into.

**E4. Contact preferences.** Per-user, per-surface: how someone prefers to be
reached and when they would rather not be. **Advisory in this design** — data the
agent reads and is expected to respect, not an enforced delivery gate. Enforcement
is deliberately deferred: an agent that genuinely needs to reach someone at 11pm
should be able to, and the interesting failure is an agent with bad judgment, not
a missing lock. The data model should not preclude enforcement later.

## Story coverage

| Story | Tracks |
|---|---|
| US-1 one agent, several surfaces | A1, A2, A3, B, C1 |
| US-2 continuity across surfaces | A1, A2, C1 — plus one adapter per surface |
| US-3 agent chooses how to reach me | E1, E2, E3, E4 |
| US-4 discretion | D1, D2, D3, C2 |
| US-5 outsider on their terms | B, plus existing `AddressingPolicy` |
| US-6 recognised as me | B3, plus existing `ExternalUserClaim` |

Two stories lean mostly on machinery that already exists:

- **US-5's authorization** is expressible today. `AddressingPolicy`
  (`core/switch_core/addressing.py`) is an ordered allow-rule list over rooms,
  room groups, users and agents, with symbolic `owner` / `owner_agents`. "This
  vendor, in this email room, humans only" is a rule with
  `rooms: [email_room]`, `users: [vendor]`, `agents: []`.
- **US-6's multi-address identity** is `ExternalUserClaim`, which is deliberately
  many-to-many, and symbolic `owner` resolution that explicitly *"survives the
  owner claiming a new platform identity."* Only the authenticity half (B3) is
  new.

## Decisions

**US-5, "I follow the whole thing from my channel": agent-posted summary, not
verbatim relay.** Mirroring an email exchange word-for-word into a Slack channel
means bridging one conversation to two surfaces, which is the fan-out design
rejected below. An agent that reports on the exchange in the channel satisfies the
story, is better behaviour anyway, and costs nothing. If verbatim relay is ever
required, the rejection has to be revisited rather than worked around.

## Rejected alternatives

**One room mapped to several surfaces.** Would require replacing
`Room.bridge_id` / `Room.external_channel_id` with a join table, and the unique
index `uq_rooms_bridge_external_channel` with it. Rejected not for migration cost
but because outbound has no safe default: with several bridges attached, every
message fans out to all of them, so internal discussion reaches an external
correspondent. It also breaks room membership as the answer to "who can see what",
which Track D now depends on. And it saves nothing — the agent must still name a
target surface per message.

Worth building later for a different purpose: a room whose point is cross-platform
*human* conversation, where fan-out to all attached surfaces is the desired
behaviour.

**Several single-room connections behind one session.** Works today with no server
change — one MCP server process per connection, since `SWITCH_CONNECTION_ID` is
read from the environment. Useful as a prototype. Rejected as the end state: fixed
at config time, multiplies the tool surface by the number of surfaces, loses
cross-surface ordering, and still requires the model to disambiguate — by server
name rather than room id, which is a second naming scheme to map onto rooms.

**Scope `all` for the working connection.** Collides with the watcher (blocker #4),
and makes the agent's context "every room anyone has ever added it to" rather than
a declared set — which also makes the Track D labelling unbounded.

**Client-side timers for E1.** Simpler, but dies with the process. See E1.

**Enforced quiet hours in E4.** See E4 — advisory by choice, not by omission.

## Open questions

1. **Gap recovery for a multi-room connection.** The buffer is capped per agent;
   overflow flags a gap whose prescribed response is "re-read room context". For a
   `multi` connection, which rooms? A1 makes `read_context(room_id=...)` possible;
   the policy still needs deciding. Re-reading every claimed room is bounded,
   because the set is explicit.

2. **Does a `multi` connection auto-claim, or claim explicitly?** Declaring the
   set at open is one round trip; N `connect_to_room` calls is consistent with
   today's flow and composes with A4. Leaning explicit.

3. **How is an audience label recomputed when membership changes?** A private
   channel that becomes public, or a guest added to a restricted one, changes the
   audience under content the agent has already read. Probably an event, but the
   agent cannot un-say what it has said.

4. **Reply-surface default when acting unprompted.** After a Track E wake-up there
   is no originating room. Probably explicit — no default — but it should be a
   deliberate decision rather than an accident of `require_connected_room`'s
   fallback.

5. **Does the egress check (D3) see the source material?** Checking an outbound
   post against "what it draws on" requires knowing what that is. The honest
   version may be narrower: check against material from rooms with narrower labels
   that the agent has read this session.
