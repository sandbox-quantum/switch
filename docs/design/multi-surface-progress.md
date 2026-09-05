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

---

## Sprint 2 — The agent has an inbox

**Unlocks US-1 and US-6.** Inbound-only email.

### What shipped

`core/switch_core/bridges/collaboration/email/` — an adapter, registered in
`main.py`, plus `authenticates_senders` on the collaboration ABC and a startup
warning in the lifecycle service.

### Decisions taken during the work

**Inbound is raw RFC 5322, not a provider's JSON.** Postmark, Mailgun and
SendGrid can all post the original message, and parsing is then the standard
library's job rather than a schema per vendor. The alternative ties the bridge
to whoever was chosen first.

**The webhook path carries a secret, minted in `prepare_config`.** Anything that
can reach the port could otherwise post mail as any allowed sender. Minted at
registration rather than defaulted on the model, because a model default is
re-evaluated on every validation — every restart would mint a fresh secret and
silently invalidate the URL the provider is posting to.

**An empty allowlist admits nobody.** Read as "open" it would be a publicly
reachable inbox wired to an agent holding the owner's authority. The
misconfiguration should cost delivery, not safety.

**`send_message` raises; `admin_message` logs.** Raising is right for an agent's
own words — the alternative is an answer that goes nowhere while the room shows
it as sent. But `admin_message` cannot raise: a new correspondent's room
resolves no agents, so the bridge core posts a notice on the room-creation path,
and left to the default that takes down room creation for a bridge working
exactly as intended. Found while writing the adapter, not by a test.

**A forward is not unwrapped.** Banner, quoted headers and chain pass through.
The consumer is a language model that reads all of it; recovering the original
sender as structured metadata means parsing a format every client writes
differently, for information nothing consumes. This was the single largest
unknown in the original design and it turned out not to be work at all.

### Knowingly left

Outbound (Sprint 5), DMARC (Sprint 5), and email-thread → Matrix-thread mapping
(`root_id` is always None; the correspondent is the thread).

---

## Sprint 3 — The agent reaches out

**Unlocks US-3.** `console/packages/switch-agent-runtime/src/schedule.ts`.

### Decisions taken during the work

**A missed recurrence fires once.** Advancing by one period leaves the next
moment still in the past, so the caller fires again immediately — an agent off
for a month posting four weekly digests in a row. It skips to the first
occurrence genuinely ahead.

**The next moment is computed from the schedule, not the clock.** A digest due
Wednesday 09:00 that ran at 09:04 is still due at 09:00 the week after.
Otherwise every late run walks the slot forward until it lands at an odd hour.

**Delays are clamped to `MAX_TIMER_MS`.** Node keeps a timer delay in a 32-bit
int; above ~24.8 days it fires *immediately* rather than late, so a monthly
wake-up armed naively goes off at once, reschedules, and goes off at once again.

**`parseWakeups` never throws.** The schedule lives in a room document a human
can open and edit, so a stray character costs the schedule and not the agent's
ability to start. Entries are dropped individually.

### Knowingly left

The host that arms the timer — same missing long-lived process as Sprint 1.

---

## Sprint 4 — The agent keeps a confidence

**Unlocks US-4.** `core/switch_core/disclosure.py`, plus the rule stated in
`build_room_instructions`.

### Decisions taken during the work

**The rule and the check are separated, and only the rule is exact.**
`may_carry` is a lattice comparison. `disclosed_span` finds runs of eight or
more words carried across verbatim, on normalised word shingles so a re-wrapped
restatement still matches. It cannot find a paraphrase — and there is a test
asserting a paraphrase is *not* caught, so nobody reads the feature as a
guarantee.

**Eight words.** Short enough to catch a lifted sentence, long enough that two
people writing independently about the same subject do not collide. A check that
fires on "let me know what you think" is a check someone disables.

**`external` is symmetric.** Nothing goes out to an outsider on the agent's
initiative, and what an outsider said is not thereby publishable either. Their
mail was sent to us, not released.

**The instructions say "this is about repeating, not knowing."** The
over-corrected failure is real and was named in US-4 alongside the leak: an
agent that refuses to *use* what it knows gives a visibly worse answer and
protects nobody.

### ⚠️ A divergence this sprint introduced

`EXTERNAL_BRIDGE_TYPES` on the Python side now labels an email room
**`external`**. The TypeScript client cannot reach the same answer: the event
envelope carries `bridge_id` but not the bridge *type*, so
`surface.ts` is called with `bridgeIsExternal: false` and labels the same room
**`private`** (it is `channel_type: direct`).

So the agent is told one thing and judged by another — exactly the failure
`disclosure.py`'s own docstring warns about for a rule written twice in two
languages. It is not yet dangerous, because the egress check is not wired to
anything, but it must be closed before it is.

**The fix**: carry the answer on the envelope rather than deriving it twice —
add an `bridge_external` boolean beside `bridge_id`, computed server-side from
`EXTERNAL_BRIDGE_TYPES`. Small, and it removes the second implementation rather
than synchronising it.

### Knowingly left

**D3 is not wired.** `disclosure.py` is the mechanism; nothing calls it on the
relay path yet. `handle_protection_verdict` in `bridge_core.py` is still behind
its TODO. The design's sequencing constraint — enforcement before an outsider is
in a room — therefore still binds Sprint 5.
