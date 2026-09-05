# Multi-surface agents — progress log

A running record of the work described in `multi-surface-agents.md`: what
shipped, what was decided and why, and what each review turned up.

**Why this file exists.** The design doc says what the system should be; the git
log says what changed. Neither says *why the plan moved* — which alternatives
were tried, which assumptions turned out wrong, and which decisions someone
later would otherwise have to re-derive from scratch. That is what goes here.

**How to read it.** Newest sprint last. Each entry has the same shape: what
shipped, the decisions taken during the work (not the ones already in the design
doc), what review found, and what was knowingly left. A decision recorded here
has already been made — reopen it deliberately, don't drift back into it.

**Process, from Sprint 1 onwards.** Tests first, then an explicit coverage
review, then implementation, then a fresh reviewer agent with no stake in the
code. Every stage commits separately so any of it can be undone on its own.

---

## Sprint 1 — Two rooms, one mind

**Unlocks US-2.** Branch `feat/multi-surface-agent`.

### What shipped

| Piece | Where |
|---|---|
| `Scope` gains `multi`; `covers()` keyed on `Connection.claims_rooms` | `core/.../protocol/connections.py` |
| Scope and filter validated at open, mapped to 400 | `connections.py`, `api/handlers.py` |
| `require_connected_room(room_id=None)` + `_resolve_room` | `core/.../operations/context.py` |
| `room_id` on `post_message`, `read_context`, `send_targeted_message` | `core/.../operations/definitions.py` |
| `StreamScope` gains `multi`; `claim()`, `acceptRooms()` | `console/packages/switch-agent-runtime/src/event-stream.ts` |
| Audience labelling | `console/packages/switch-agent-runtime/src/surface.ts` |
| Labels on both delivery paths | `bin.ts`, `apps/.../switch-event-format.ts` |

### Decisions taken during the work

**`room_id` went on three operations, not all 22.** The other 19 keep raising on
ambiguity. Their error already says what happened, nothing in these stories
needs them cross-room, and widening the tool surface costs churn on three
connector skills. Widen when something asks.

**Rooms are declared at open, not claimed afterwards — and this was already
built.** Open question 2 in the design doc resolved itself: the events endpoint
already claims every room in its `rooms` query parameter before the stream
starts, because catch-up runs immediately and a room subscribed afterwards
arrives too late for the buffered events a resume exists to recover.

**A fifth audience label, `unknown`.** The design named four and had no answer
for a room carrying no `channel_type`. Defaulting to `open` or `external` looks
conservative but is a claim about who can read the room, and a wrong claim in
the narrow direction is a disclosure nobody sees. The flow rule treats `unknown`
as the widest audience.

**`bridgeIsExternal` is a required argument.** Optional, its absent-default was
"internal" — the same unsafe direction `unknown` exists to avoid, arriving
through the back door. Required means the email bridge cannot be added without
someone answering the question.

**`room_name` is omitted when unknown, not filled with the room id.** A fallback
here does not read as "no name available"; it reads as the room being called
`!abc:server`. The id is already in the same object.

**The audience is rendered in prose only when known.** `[unknown]` on every line
of every single-room session is noise. The structured MCP meta keeps the
explicit value, where it is greppable.

**`repoint` subscribes with takeover; `claim` stays cooperative.** Restoring a
session to a room it owns usually meets that agent's own stale connection, and
the reconnect URL takes over anyway. Gaining a surface is not a claim on a room
someone else is working in.

**The long-lived multi-room host is a separate process, not a flag on
`bin.ts`.** A connector session is correctly one room. `bin.ts` still opens
`scope: 'single'`.

### What review found

A fresh agent reviewed the diff. Two findings were blocking, and both were the
same mistake in different places — a second copy of a rule that did not learn
about the new scope.

1. **`scope=multi` was rejected with a 400.** The events endpoint validated
   scope against a hard-coded pair, in front of the registry. The feature was
   unreachable in a running system; a client would have retried the 400 forever.
   Fixed by deleting the duplicate, leaving one validator.
2. **A room-less `multi` connection consumed its own buffer.** The delivery
   loop's "park until a room is claimed" guard read `scope == "single"` — the
   twin of the line changed in `covers()`. Both now read one
   `Connection.claims_rooms` property.

Also fixed: the `repoint` takeover regression, the `room_name` fallback, the
required `bridgeIsExternal`, labels missing entirely from the text-injection
path used by Codex and OpenCode, `read_context`'s contradictory docstring, a
prototype-chain leak in the channel-type lookup, a `StopIteration` that would
have surfaced as a 500, and the runtime version bump (0.3.3 → 0.4.0 in
`artifacts.yaml`).

### A pattern worth naming

**Four tests passed while asserting nothing.** `"not in required"` is satisfied
by a parameter that does not exist; `scope as 'multi'` let a runtime test pass
over a type no client could ask for; `"room" in message` matched a different
error entirely; and `_take(stream, 1)` suspends a lazy generator before the loop
under test ever runs. Every one of them was green for a reason unrelated to the
behaviour it named.

The habit that catches these: **run the test against the unfixed code and read
the failure**. A red that does not mention the thing you are building is not a
red.

### Knowingly left

- The **long-lived host** that opens a `multi` connection. The protocol client
  supports it; nothing runs it. Sprint 1's acceptance scenario cannot be
  demonstrated end to end until it exists.
- `A3` (`room_name` on the envelope), `A4` (membership-change notification),
  `A5` (reject a second `all` connection) — all deferred, reasons in the design
  doc.
- **Two validation gaps in this environment**: Postgres-backed core tests do not
  run (testcontainers stalls without starting a container), and the desktop app
  has no `node_modules`, so `switch-event-format.ts` and its two new tests are
  verified by inspection only. Both need a real run before merge.
- Two open judgement calls: whether `external` should be its own meta key rather
  than collapsing into `audience` (it loses the orthogonality the design calls
  for, and Sprint 4's flow rule will be written against it), and the stale scope
  tables in `docs/old/api/AGENT_PROTOCOL.md`.
