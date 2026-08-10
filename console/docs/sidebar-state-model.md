# Sidebar state model — audit and target design (CHOO-1943)

Status: **design note, pre-implementation.** Part 1 and 2 are the audit of what
exists today. Part 3 is the proposed target. Nothing here is implemented yet.

Scope: the left sidebar, rooms view first, but the plumbing is shared with the
agents view and the servers section so both are covered.

## The thesis

The sidebar does not have a state model. It has five independent caches, filled
by four different mechanisms, refreshed on triggers that do not line up. Every
reported symptom is a place where two of them are read side by side and
disagree.

The fix is not to add refresh calls at the places that currently look wrong.
It is to make each fact have one owner and one read, so that two parts of the
view cannot hold different answers to the same question.

## Part 1 — What the sidebar shows, and where each fact comes from

Five stores back the rooms view. Two of them are both called
`switchRoomsStore`, are unrelated, and are imported into the same file under
different aliases.

| # | Store | Holds | Source | Kind |
|---|---|---|---|---|
| A | `switch-rooms/switch-rooms-store` | session → connected room | main process, seeded once + live event | push |
| B | `switch-servers/switch-rooms-store` | room catalogue + **per-agent** membership | gateway HTTP | pull |
| C | `locations/stores/agents-store` | this install's agents | main process (SQLite) | pull |
| D | session manager / session stores | sessions and their status | main process, live events | push |
| E | `switch-servers-store` | server connection status | gateway HTTP | pull |

Plus **react-query**, used by the invite picker only, as a sixth cache holding a
sixth copy of room membership.

### Per rendered element

| Rendered | Read from | Refreshed by |
|---|---|---|
| Room rows (which rooms exist) | B `allRoomsByServer` / `ownedRoomsByServer`, unioned with membership keys and session buckets | mount, window focus, create-room, add-agent |
| Room name, bridge icon, channel link, createdAt | B `roomNames` etc. | same as above |
| **Number badge on a room row** | **D + A** — count of live sessions bucketed into that room | session events (push, continuous) |
| **Agent rows under a room** | **B `roomsByAgent`, inverted** | mount, window focus, add/remove agent |
| Agent display name on those rows | react-query, per row | own query lifecycle |
| Sessions under an agent-in-room | D | session events |
| Agent status dot | D, via `sessionAgentStatusChangedChannel` | push, continuous |
| Server status dot | E | mount, window focus, login/logout |
| Room ordering | local view-state | drag, persisted debounced |
| Expand/collapse | local view-state | user |

### The shape problem

Membership is stored **agent-keyed** — "which rooms is this agent in?" — and the
rooms view needs the opposite — "who is in this room?". It gets there by
inverting the per-agent cache at render time.

That inversion is only as complete as the set of agents that happen to be in the
cache, and that set is only ever this install's **local** agents. Two facts
follow, and they cause most of the observed bugs:

1. A room's member list can only ever contain agents that exist locally in this
   Switch Console. Server-side agents are structurally unrenderable.
2. A membership that was never fetched, and a membership that failed to fetch,
   both read as "this agent is in no rooms" — indistinguishable from the truth.

## Part 2 — Mutation → view paths, and which are broken

Legend: ✅ converges · ⚠️ converges only on window focus · ❌ never converges

| # | Mutation | Path today | |
|---|---|---|---|
| 1 | Add agent to room (local agent) | modal refetches memberships + room list | ✅ |
| 2 | **Add agent to room (agent not local to this install)** | picker offers it, sidebar can never draw it | ❌ |
| 3 | Remove agent from room | refetch after RPC | ✅ |
| 4 | Create room in-app | refetches room list | ✅ |
| 5 | **Room archived / renamed / deleted** | no in-app path exists; only happens externally | ⚠️ |
| 6 | **Agent created after the sidebar mounted** | membership load runs once on mount with a fixed agent list; the retry helper only refreshes keys already cached | ⚠️ |
| 7 | Agent deleted | agents store reloads | ✅ |
| 8 | **Membership changed externally** (Slack, gateway, another install) | nothing observes it | ⚠️ |
| 9 | **Server becomes unreachable** | room list keeps last-known values silently | ❌ (never disclosed) |
| 9b | **Sign in to a server** | the room load skips disconnected servers and login does not re-run it | ⚠️ (rooms simply absent until focus) |
| 10 | **Membership fetch fails** | agents silently vanish from their rooms | ❌ (never disclosed, never retried) |
| 11 | **Session→room seed fails at boot** | flag is set before the call and there is no error branch, so every badge reads 0 forever | ❌ |
| 12 | Drag-to-reorder | local view-state, applied immediately | ✅ |
| 13 | Session starts/stops/changes room | live events | ✅ |

### The two reported symptoms, explained

**Counter and children disagree.** The badge counts *sessions*; the list under it
shows *members*. Different collections, different stores, different refresh
triggers. A room with three members and nothing running shows three rows above a
badge reading `0`; one agent running two sessions shows one row above a badge
reading `2`. They are not the same question, so no amount of refreshing makes
them agree.

Worth noting: the gateway already returns a real member count per room. It
reaches the renderer's types and is read by nothing.

**Picker doesn't reflect membership.** The picker asks the server the room-keyed
question directly and lists *every* agent on the server. The sidebar asks the
agent-keyed question about *local* agents only. Two different questions, two
different caches. So the picker can correctly hide someone the sidebar cannot
show, and correctly offer someone the sidebar will never draw once added.

Also, when the picker's member lookup fails it treats the room as empty: it
offers agents already in it, and can display "every agent on this server is
already in the room" when in fact it simply failed to ask.

### Room names are a third independent fetch, and fail silently

A room's **name** does not come from the same read as its membership. It comes
from the per-server room list, into its own `roomId → name` map, on its own
schedule (mount + window focus). Both maps are memory-only; neither is
persisted.

The agent view exposes this most sharply, because there the room *id* and the
room *name* have different reliability:

- The id comes from the session→room push channel — immediate, and covers any
  room a session is in, including rooms on servers whose list was never fetched.
- The name comes from `loadRoomNames`, which **skips every server that is not
  connected at that moment** and **swallows a failed fetch** (`catch {}`), with
  no retry until the next focus.

So the view knows a room exists but has never learned its name, and
`roomLabel` renders `Room 39c66c86` — a plausible-looking label, not a disclosed
unknown. Because the map is memory-only, every launch also starts with zero
names, so short ids are visible until the first fetch returns.

Target: the name is part of the same room-keyed read as the membership, an
unknown name renders as a loading state rather than a short id, and last-known
names are persisted so a restart does not begin blind.

### Two more worth fixing while here

- **Agent filters silently narrow room membership.** The member list is built by
  walking the filtered agent list, so a filter set in the agents view removes
  members from rooms in the rooms view — while the rooms view's own filter
  indicator reads "off". It also suppresses the membership fetch for those
  agents entirely.
- **A room known only through membership renders degraded**: short-id label
  instead of its name, no bridge icon, and both "add agent" and "remove agent"
  silently refuse, because the fields those need are filled by a different fetch.
- **Signing in to a server does not load its rooms.** The room load skips
  servers that are not connected, and nothing re-runs it after login — so a
  server you just signed into contributes no rooms until the window is
  refocused. Same for starting the managed stack.

## Part 3 — Proposed target

### 3.1 One owner per fact

Introduce a single room-state store that owns the room-keyed view of the world,
replacing the render-time inversion:

- `rooms: Map<roomId, RoomState>` where `RoomState` carries the room's identity
  **and** its member list, from one read.
- Membership is fetched **room-keyed** (the endpoint the picker already uses),
  not derived by inverting per-agent caches.
- The per-agent view, where it is still needed, is derived *from* this — not
  alongside it.

### 3.1b One state, many writers, one reader

Agreed with louis.amaudruz: the room state is written from several directions
but read from exactly one place.

Writers, all through the same store API rather than into private caches:

- **Local mutation** — create room, add/remove agent. Seeds the fields it
  already knows (a room created here knows its own name) and then confirms
  against the server.
- **Server read** — the room list and room-keyed membership. Fills gaps and
  corrects drift; also the background reconcile.
- **Live push** — session→room today; server-pushed membership later, if it is
  built. Slots in as a third writer without changing anything downstream.

Reader: everything. Room rows, the member list, the counter, the invite picker.
No component holds its own copy and none fetches at render time. Because the
store is observable, a write from any of the three writers repaints the sidebar
without a per-callsite refresh — which is what makes "the view updates" a
property of the design instead of something each callsite must remember.

The current failure is precisely the absence of this: five caches, so a write
lands in one and misses the others.

### 3.2 Derive rendered numbers from the rendered collection

The badge becomes the length of the collection rendered beneath it. Not a
separate fetch, not the gateway's count, not a session tally. If the row shows
N children, the badge says N — they cannot disagree because there is one array.

Where the gateway's count is genuinely useful is as a **reconciliation signal**,
not as the number: if the server says a room has five members and we can only
render three, that gap is the "agents we cannot draw" case above, and it should
be disclosed on the row rather than silently rendered as three.

### 3.3 Refresh strategy — one rule, uniformly

**No room state reaches the UI by push today** — the renderer is told when a
session changes room, and nothing else. But the plumbing is closer than it
looks, and this is worth knowing before choosing: the main process **already
holds a gateway event stream**, and it **already receives room-join events**.
They are consumed by injecting a line into the agent's terminal and are never
re-emitted to the renderer. The stream is currently per-agent and filtered to
addressed events, so it is not a general room-state feed as-is — turning it into
one needs work on both sides, not just here.

So push is a real option later, not a free one now. The proposal below is
correct either way and leaves a clean seam for it.

Proposed, in order of preference per trigger:

1. **Invalidate on mutation.** Every room mutation invalidates the affected
   room's entry and re-reads it — one code path, not per-callsite refetch calls.
2. **Reconcile on focus**, as today, but as one coherent pass over the whole
   room state rather than three independent refreshes that can half-fail.
3. **No optimistic writes** for membership. The current fire-then-refetch is
   correct and should stay; optimism here would add a fourth kind of truth.
4. **External changes converge on the focus reconcile**, and the UI says how
   fresh it is rather than implying it is live.

This is the decision `CHOO-1868` (stale agent-status indicators) should inherit
rather than reinvent — that ticket is the same defect class for a different
fact, and the two must not end up with competing refresh models. If a room-state
push channel is ever added server-side, it slots in at (1) and the rest stands.

### 3.4 Fail loud on stale

The rule: **"I don't know" must be renderable.** Today it is not — every unknown
collapses to an empty array and renders as a confident zero.

- A membership that has never loaded, failed to load, or belongs to an
  unreachable server renders as *unknown*, not as empty.
- The room row discloses it, and the failed read is retried rather than being
  dropped from the retry set because it has no cache entry.
- The picker refuses to claim "everyone is already in the room" when the lookup
  that would prove it failed.
- The boot seed for session→room gets an error branch instead of wedging.

## Open questions for review

1. **Scope.** Part 3.1 is a real refactor of how the rooms view gets its data.
   The alternative is to fix 3.2 and 3.4 only, which kills the two reported
   symptoms and the silent-empty class, but leaves membership agent-keyed and
   leaves case 2 (non-local agents) unfixable. Worth doing the full thing?
2. ~~**Non-local agents.**~~ **Decided (louis.amaudruz).** Both the room's
   member list and the invite picker are restricted to agents that exist on this
   Switch Console — the sidebar only shows what it can act on. Consequences: a
   server-side agent cannot be invited from Switch Console at all, and the room row
   discloses the count it cannot draw so a hidden member is not mistaken for an
   absent one.
3. ~~**Polling.**~~ **Decided (louis.amaudruz).** Add a slow background
   reconcile so externally-originated changes converge on their own rather than
   only on window focus.
