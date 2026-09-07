# Multi-surface agents

> **Read `multi-surface-status.md` first.** This is the design as written
> before any of it ran. Most of it held, and three things did not: US-1's
> headline scenario is refused by US-4's rule, the user story that emerged is
> an intelligence desk rather than a hand-off, and a third of the code here was
> built and never wired to anything. The status doc says which is which.

**Status:** design
**Scope:** agent protocol (connections, operations), collaboration bridges
(email, sender authenticity), room disclosure labelling

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

- **Composing email to an arbitrary new address.** Even under US-5, "reply by
  email" means replying into a conversation the agent is already party to. Cold
  outbound is a separate capability with its own authorization question.
- **Merging several surfaces into one room.** See *Rejected alternatives*.
- **A proof of non-disclosure.** US-4 is addressed with labelling, instruction and
  an auditable egress check. Paraphrase defeats any text-matching rule, so the
  guarantee is bounded and stated as such in Track D.

## Why this does not work today

Rooms already model surfaces, and the event buffer is already per-agent and
room-tagged. Eight things block the stories above.

### 1. A multi-room connection can receive but cannot act

`require_connected_room()`
(`core/switch_core/bridges/agent/operations/context.py`) raises when a connection
covers more than one room:

> "This connection covers several rooms; the operation needs one — pass the room
> explicitly or use a single-room connection."

No operation accepts a room. Delivery to a multi-room connection works; every
action fails.

### 2. There is no scope for "these rooms"

`Scope = Literal["single", "all"]`
(`core/switch_core/bridges/agent/protocol/connections.py`). `single` clears the
room set on each claim; `all` leaves it empty and covers everything unclaimed.
Neither expresses "I work in this declared set."

`Connection.rooms` is already a `set[str]` and `claim_room()` only special-cases
`single`. The data model is multi-room already; the type forbids it.

### 3. Events name a room but not a surface

The envelope carries `room_id` and `channel_type`. `room_name` is documented in
`docs/old/api/AGENT_PROTOCOL.md` §6.1 as *"proposed, not implemented"*. An agent
holding two surfaces in one context window needs to tell them apart; a UUID does
not do that.

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

Every agent turn today is a response to an inbound event. US-3 needs an agent that
acts at a time of its own choosing.

### 6. There is no way to reach a *person*, only a room

The agent posts into rooms. Choosing to text someone means resolving person →
their surfaces → a room on the right bridge. `ExternalUserClaim`, `create_room`
and the adapters' `create_dm_channel` all exist; nothing composes them.

### 7. Unified context has no confidentiality model — and today's isolation is accidental

Session-per-room currently gives **accidental isolation**: the session answering
in a team channel never saw the private DM, so it cannot leak it. That is not a
designed protection, but it is a real one, and the `multi` connection dissolves it
deliberately.

After this change the only thing between a private DM and a public channel is the
model's judgment inside one context window. **The unification must not ship
without at least the visible half of the disclosure story**; see the delivery
plan.

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
              ├── room A  ──bridge──▶  Slack channel       [restricted]
              ├── room B  ──bridge──▶  email correspondent [external]
              └── room C  ──bridge──▶  Slack DM            [private]
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
ordering across every surface. This is the concrete reason to prefer one
multi-room connection over several single-room ones.

### Disclosure: derive the label, tell the agent, check the egress

Three layers, weakest to strongest, because no single one is sufficient:

1. **Every room has an audience label, derived rather than stored.** The envelope
   already carries `channel_type`, and the bridge is already known, so the client
   can compute this with no schema change:

   | label | meaning | derived from |
   |---|---|---|
   | `private` | one human and the agent | `direct` |
   | `restricted` | a named, closed group | `channel_private`, `group` |
   | `open` | anyone in the workspace | `channel_public`, `lobby` |
   | `external` | includes people outside the organisation | a bridge whose correspondent is outside |
   | `unknown` | not characterisable | no `channel_type`, or one we do not recognise |

   `private < restricted < open` is an ordering. `external` is **orthogonal**: an
   email room with a single vendor in it is tiny but outside the trust boundary.

   `unknown` was added while implementing Sprint 1. The design originally had
   four labels and no answer for a room carrying no `channel_type`. Defaulting
   such a room to `open` or `external` looks conservative but is a *claim about
   who can read it*, and a wrong claim in the narrow direction is a disclosure
   nobody sees. `unknown` is honest, and the flow rule treats it as the widest
   audience — so over-restricting costs a refusal a human can authorise, while
   under-restricting costs a leak.

   A stored per-room override can be added later if a room needs to disagree with
   its type. Nothing in these stories requires one.

2. **The agent sees the label on every event and is given the flow rule.** Content
   may move into a room of equal or narrower audience. Moving it into a wider or
   `external` room requires explicit authorization from a human *in that turn*. A
   model cannot be discreet about a boundary it cannot see, so this layer is the
   prerequisite for the other two rather than an alternative to them.

3. **Rooms may opt into an egress check.** `Room.protection_config` already
   exists, and `handle_protection_verdict` in `bridge_core.py` can already edit or
   delete a relayed message — currently behind `# TODO: use this when protection
   setup is done`. That is the enforcement seam.

**What this does and does not guarantee.** It makes the boundary visible to the
model, makes crossings auditable, and lets a sensitive room enforce a check before
relay. It does **not** make leakage impossible: paraphrase defeats any text-level
rule. Stated plainly here so nobody reads the feature as a proof.

### Authenticity is a property of an inbound message, not an assumption

`CollaborationAdapter` gains a class-level `authenticates_senders: ClassVar[bool]
= True`, matching the existing idiom of `supports_channel_creation` and
`supports_directory_search`. Every current adapter inherits `True`. Email sets it
`False` and supplies per-message verification instead.

`InboundMessage` gains an authenticity result. The addressing layer requires an
authenticated sender before any owner-scoped rule can match, so unverified mail
cannot impersonate the owner. Refusal is visible, not a silent downgrade.

The strength of that verification is phased: an allowlist of claimed addresses is
sufficient while the only legitimate sender is the owner, and becomes insufficient
the moment an outsider is a legitimate correspondent. See the delivery plan.

## Changes

Five tracks. A and D are protocol/architecture; B is new code against a seam that
does not move; C is the client; E is what remains of proactive agency after most
of it turned out to be client behaviour.

Each item is annotated with the sprint that delivers it. Items marked *deferred*
are designed but not scheduled — pull them in when they bite.

### Track A — protocol core

**A1. Room-addressed operations.** *(Sprint 1 — load-bearing)*

Add an optional `room_id` to `post_message`, `read_context` and
`send_targeted_message`. Resolution moves into
`require_connected_room(room_id=None)`:

- omitted, connection covers one room → that room (today's behaviour, unchanged)
- omitted, connection covers several → error naming the ambiguity
- supplied → must be in `conn.rooms`, else a clean error

The other room-scoped operations in `definitions.py` keep raising on ambiguity.
That error already says exactly what happened, and nothing in these stories needs
to create a room document from a multi-room connection. Widen the set when
something asks for it.

`definitions.py` is the single registry behind both the MCP server and the HTTP
front door, so this lands on both at once. It is a public tool-surface change, so
the three connector skills under `connectors/*/skills/switch/SKILL.md` must be
updated together. Note `test_mcp_tool_surface.py` checks tool *names* against each
skill's `## Tool index` and that all three index the same set — it will not catch
a new parameter documented on only one host, so diff the skills against each other
after editing.

This also gives `read_context(room_id=...)`, which makes gap recovery well-defined
for a multi-room connection.

**A2. `Scope` gains `"multi"`.** *(Sprint 1)* Add the literal; change `covers()`
so the explicit-set branch applies to everything that is not `all`. `claim_room()`
already accumulates for any non-`single` scope.

Carries one thing the design did not anticipate: **`scope` and `filter` are now
validated at open.** Both arrive off a query string as bare strings, so the
`Literal` types constrained only callers that get type-checked — nothing at
runtime rejected a bad value. Harmless while `covers` special-cased `single`;
once it reads "anything that is not `all` covers only what it claimed", a
misspelled `all` becomes a connection that claims nothing, covers nothing, and
logs a successful connect. The agent goes silent everywhere with no error
anywhere.

**A3. `room_name` on the event envelope.** *(deferred)* Implement what §6.1 already
specifies. Until then the client resolves names from `list_rooms` and caches them,
which is enough.

**A4. Membership-change notification.** *(deferred)* A `multi` connection receives
nothing for rooms it has not claimed, so nothing tells it the agent was added to a
new room. Irrelevant while room sets are operator-configured; needed before any
self-service flow, because the failure mode is silent — the agent simply never
speaks there.

**A5. Reject a second `all` connection per agent.** *(deferred)* Backstop for
blocker #4, which cannot occur once the working connection is `multi`. Worth doing
because the current failure is silent duplicate delivery plus a nondeterministic
holder.

### Track B — email bridge

**B1. The adapter.** *(Sprint 2)* A new
`core/switch_core/bridges/collaboration/email/` implementing
`CollaborationAdapter`, plus an `EmailConnectionConfig`, registered with one line
in `core/switch_core/main.py`. No frontend work: `GET /types` builds the operator
form from the config class's JSON schema, and nothing in `gateway/src` names a
bridge type.

Class-level declarations, all already supported by the ABC:
`supports_channel_creation = False`, `supports_directory_search = False`,
`renders_custom_url_schemes = False`, and `authenticates_senders = False`.
`send_typing` is a no-op so the default runtime-state handling never emails a
"working on it" status. `update_message` / `delete_message` raise — email is
append-only, and the only live call site is an unwired protection-verdict path.

Inbound arrives by provider webhook over the adapter's own HTTP listener, the way
Teams does, with `exclusive_resource()` returning the port so a collision is
refused at registration rather than dying in a background task.

**B2. Inbound parsing.** *(Sprint 2)* MIME and HTML to text, attachment relay
through the existing `Attachment` model bounded by `_max_attachment_bytes`, and
loop protection — honour `Auto-Submitted:`, `List-*`, `Precedence: bulk`, because
an autoresponder loop is a real failure rather than a cosmetic one.

**Forward unwrapping is not required.** Recovering the original
`From`/`Subject`/`Date` from a forwarded message has no cross-client standard, and
it was the only genuinely uncertain item in this design. It is also unnecessary:
the consumer is a language model, and the raw forwarded body — banner, headers,
quoted chain and all — reads fine. The same goes for signature and quoted-history
stripping, which cost tokens without affecting comprehension. *(deferred, and only
if structured metadata is later wanted)*

**B3. Sender authentication.** *(Sprint 2 partial, Sprint 5 full)* See blocker #8.

- **Sprint 2 — allowlist.** Only addresses claimed via `ExternalUserClaim` reach
  the agent. Everything else is refused with a stated reason. Sufficient while the
  owner is the only legitimate sender.
- **Sprint 5 — SPF/DKIM/DMARC**, mostly available as headers or provider-supplied
  fields. Required once a non-owner correspondent is legitimate, because the
  allowlist then has to admit strangers.

**B4. Outbound.** *(Sprint 5)* SMTP or provider API, setting
`In-Reply-To`/`References` so replies thread in the recipient's client.
`translate_outbound` renders Switch markdown to multipart HTML.

**B5. Room mapping.** *(Sprint 2)* Email rooms are `channel_type="direct"`, which
means every message addresses the agent — no `@mention` convention to invent.
`_create_room_for_channel` already has the `direct` branch. Their audience derives
to `external`.

### Track C — client

**C1. A `multi`-scope, long-lived client.** *(Sprint 1)* `bin.ts` hardcodes
`scope: 'single'`. Scope and filter become options, and something holds the
connection open, claims its rooms, and routes each reply to the room its trigger
came from. Depends on A1 and A2.

**C2. Surface labelling in context.** *(Sprint 1 — not optional)* Every event the
client surfaces to the model carries its room name and derived audience label.
This is the client half of Track D layer 1, and it computes the label from
`channel_type` plus the bridge, both of which the client already has. The labels
are useless if the context window flattens them away.

**C3. Durable working state.** *(Sprint 3)* A long-lived agent should not depend on
its context window surviving for weeks. Room documents (`create_room_document` /
`update_room_document`, already in `definitions.py`) are the natural store, and
give a restart something to rehydrate from other than full room history.

### Track D — disclosure control

**D1. Derived audience labels.** *(Sprint 1, as C2)* No schema column: the label is
computed from what the envelope already carries. A stored override is possible
later and is not needed by these stories.

**D2. The flow rule in room instructions.** *(Sprint 4)* Rooms already carry
`instructions`. The rule is stated to the agent as part of its standing context,
alongside the per-event labels.

**D3. Egress check.** *(Sprint 4)* Wire `handle_protection_verdict` for rooms that
opt in via `protection_config`. An outbound post to a room labelled wider than the
material it draws on is checked before relay, and refusal is visible in the room
rather than silent.

### Track E — proactive agency

**E1. Scheduled wake-ups.** *(Sprint 3)* Pending wake-ups live in the agent's room
document (C3); the long-lived client arms timers for them and re-arms on restart.

**No server-side scheduler.** A wake-up delivered when no client is connected has
nobody to wake — the agent cannot act without its process either way — so
server-side durability buys nothing that C3 does not already provide.

**E2. Surface directory.** *(deferred)* Resolve a person to the surfaces that reach
them: their `ExternalUserClaim` rows, each on a bridge, with what that bridge can
do.

**E3. Reach a surface.** *(deferred)* Given a person and a chosen surface,
resolve-or-create the direct room. Composes `create_room` with the adapters'
`create_dm_channel`.

E2 and E3 are deferred because **the claimed room set already is the agent's list
of surfaces** — choosing among them is `post_message(room_id=...)`, which is A1.
They matter only for reaching a surface no room exists for yet.

**E4. Contact preferences.** *(Sprint 3)* How someone prefers to be reached and
when they would rather not be, stated in the agent's instructions rather than
modelled as data. **Advisory** — an agent that genuinely needs to reach someone at
11pm should be able to, and the interesting failure is bad judgment, not a missing
lock.

## Delivery plan

Five sprints, each unlocking at least one story. The ordering exploits a fact that
is easy to miss: **Switch already has five collaboration bridges**, so multi-surface
can be proved with Slack and Telegram before any email work exists. That keeps
Sprint 1 pure protocol and isolates all the email risk in Sprint 2.

| Sprint | Unlocks | New surface work |
|---|---|---|
| 1. Two rooms, one mind | US-2 | none — uses existing bridges |
| 2. The agent has an inbox | US-1, US-6 | email, inbound only |
| 3. The agent reaches out | US-3 | none |
| 4. The agent keeps a confidence | US-4 | none |
| 5. The agent has a correspondent | US-5 | email, outbound |

### Sprint 1 — Two rooms, one mind

**Unlocks US-2.** Ships A1, A2, C1, C2.

*Acceptance:* three rounds deep in a Slack channel about something, then continue
from a Telegram DM — the agent knows what "it" refers to and answers where you
asked. The minimum version is one bridge and two rooms (a channel and a DM); the
convincing version is two bridges.

C2 is not polish. From this sprint on, two rooms with different audiences share
one context window, and blocker #7 is live.

**Status: protocol and runtime library done; the long-lived host is not.**

Landed: `multi` scope and the `covers` branch (A2, plus scope/filter validation
at open, which nothing did before); `room_id` on `post_message`, `read_context`
and `send_targeted_message` (A1); `StreamScope`, `claim` and `acceptRooms` on
`SwitchEventStream`, and the derived surface label on every notification (C1
library half, C2).

Outstanding: the **process** that opens a `multi` connection and stays up. The
protocol client supports it; nothing yet runs it. `bin.ts` still opens
`scope: 'single'`, which is correct for a connector session — a Claude Code or
Codex session is one room — so the long-lived agent is a separate host rather
than a flag on that one. It needs its own tests, and they cannot be unit tests:
`bin.ts` reads config at module scope and exits from it, so the existing harness
spawns the built artifact.

### Sprint 2 — The agent has an inbox

**Unlocks US-1 and US-6.** Ships B1, B2, B3 (allowlist), B5.

Those two stories are coupled and the coupling is not optional: agents are
owner-only by default, so an email whose sender cannot be established either fails
to address the agent — useless — or succeeds, which is blocker #8.

*Acceptance:* forward an email from your phone with no note. Later, in Slack, ask
about it; it answers. Forward from an unclaimed address and it refuses, out loud.

Largest sprint, but well short of a full email bridge — outbound and forward
unwrapping are both out.

### Sprint 3 — The agent reaches out

**Unlocks US-3.** Ships C3, E1, E4.

*Acceptance:* on a schedule it set for itself, the agent posts a digest in the
channel unprompted. Something time-sensitive goes to a DM instead. It survives a
client restart with its schedule intact.

### Sprint 4 — The agent keeps a confidence

**Unlocks US-4.** Ships D2, D3.

Sprint 1 made the boundary visible; this makes it enforceable. It is also the
**gate for Sprint 5** — the blast radius is small while the only person emailing
the agent is its owner, and it grows the moment an outsider is in a room.

*Acceptance:* DM the agent a concern about a vendor, then ask about that vendor in
the team channel. The answer is shaped by what it knows and does not quote you.
Then try to make it quote you, and watch the check refuse.

### Sprint 5 — The agent has a correspondent

**Unlocks US-5.** Ships B4, B3 (full DMARC), an addressing rule admitting an
external principal, and the agent-posted channel summary recorded under
*Decisions*.

The addressing rule needs no new machinery: `rooms: [email_room]`,
`users: [vendor]`, `agents: []` is expressible in `AddressingPolicy` today.

*Acceptance:* a vendor emails a revised quote. The agent answers them by email. You
follow it from your channel and step in only for the decision that is yours.

### Sequencing constraints

Only two are hard; everything else may reorder.

1. **C2 ships in Sprint 1.** The moment one context spans two audiences, the labels
   have to be there.
2. **Sprint 4 precedes Sprint 5.** An external correspondent in a room, with
   unified context and no enforcement, is where a disclosure failure becomes
   expensive rather than embarrassing.

## Story coverage

| Story | Delivered by | Leans on what already exists |
|---|---|---|
| US-1 one agent, several surfaces | Sprints 1–2 | |
| US-2 continuity across surfaces | Sprint 1 | the five existing bridges |
| US-3 agent chooses how to reach me | Sprint 3 | room documents |
| US-4 discretion | Sprints 1, 4 | `protection_config`, room `instructions` |
| US-5 outsider on their terms | Sprint 5 | `AddressingPolicy` |
| US-6 recognised as me | Sprint 2 | `ExternalUserClaim`, symbolic `owner` |

Two stories lean mostly on machinery that already exists:

- **US-5's authorization** is expressible today. `AddressingPolicy`
  (`core/switch_core/addressing.py`) is an ordered allow-rule list over rooms, room
  groups, users and agents, with symbolic `owner` / `owner_agents`.
- **US-6's multi-address identity** is `ExternalUserClaim`, which is deliberately
  many-to-many, and symbolic `owner` resolution that explicitly *"survives the
  owner claiming a new platform identity."* Only the authenticity half is new.

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
which Track D depends on. And it saves nothing — the agent must still name a target
surface per message.

Worth building later for a different purpose: a room whose point is cross-platform
*human* conversation, where fan-out to all attached surfaces is desired.

**Several single-room connections behind one session.** Works today with no server
change — one MCP server process per connection, since `SWITCH_CONNECTION_ID` is
read from the environment. Useful as a prototype. Rejected as the end state: fixed
at config time, multiplies the tool surface by the number of surfaces, loses
cross-surface ordering, and still requires the model to disambiguate — by server
name rather than room id, which is a second naming scheme to map onto rooms.

**Scope `all` for the working connection.** Collides with the watcher (blocker #4),
and makes the agent's context "every room anyone has ever added it to" rather than
a declared set — which also makes Track D's labelling unbounded.

**A server-side scheduler.** Durable across client restarts, but a wake-up with no
client connected has nobody to wake. C3 already gives durability where it matters.

**A stored room audience column.** `channel_type` plus the bridge already
determines the label for every case these stories need. Add the override when a
room needs to disagree with its type, not before.

**`room_id` on all room-scoped operations.** Tidier, but three operations carry the
stories and the remaining error message is already clear about what happened.

**Forward unwrapping as a requirement.** See B2 — the consumer is a model, and the
raw forward reads fine.

**Enforced quiet hours.** See E4 — advisory by choice, not by omission.

## Open questions

1. **Gap recovery for a multi-room connection.** The buffer is capped per agent;
   overflow flags a gap whose prescribed response is "re-read room context". For a
   `multi` connection, which rooms? A1 makes `read_context(room_id=...)` possible;
   the policy still needs deciding. Re-reading every claimed room is bounded,
   because the set is explicit.

2. ~~**Does a `multi` connection auto-claim, or claim explicitly?**~~ **Resolved —
   it was already built.** The stream endpoint takes a `rooms` query parameter and
   claims every room in it before the stream starts
   (`core/switch_core/bridges/agent/api/handlers.py`), for a reason that applies
   with equal force to several rooms: catch-up runs immediately, so a room
   subscribed afterwards arrives too late for the buffered events a resume exists
   to recover — they are skipped as "not covered" *and* the cursor advanced past
   them. So the set is declared at open, re-declared on every reconnect, and a
   room acquired later is added with `connect_to_room`.

3. **How is an audience label recomputed when membership changes?** A private
   channel that becomes public, or a guest added to a restricted one, changes the
   audience under content the agent has already read. Probably an event — but the
   agent cannot un-say what it has said.

4. **Reply-surface default when acting unprompted.** After a Sprint 3 wake-up there
   is no originating room. Probably explicit — no default — but it should be a
   deliberate decision rather than an accident of `require_connected_room`'s
   fallback.

5. **Does the egress check (D3) see the source material?** Checking an outbound post
   against "what it draws on" requires knowing what that is. The honest version may
   be narrower: check against material from rooms with narrower labels that the
   agent has read this session.
