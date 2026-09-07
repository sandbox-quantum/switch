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

## ⚠️ Open safety register

**D4 — ~~19 operations are uncallable under `multi` scope~~ — FIXED 2026-09-06.** `room_id` was added to
`post_message`, `read_context` and `send_targeted_message`. The other 19 call
`require_connected_room()` with no argument, so with two rooms held they raise
*"This connection covers several rooms; the operation needs one — pass room_id
explicitly"* and the caller has no parameter to comply with. Confirmed live: a
session holding two rooms had `list_participants` and `read_context` refused.
Affected: `accept_task`, `assume_role`, `cancel_task`, `create_room_document`,
`define_role`, `delegate_task`, `delete_role`, `delete_room_document`,
`edit_role`, `finalise_task`, `list_linked_rooms`, `list_participants`,
`list_references`, `list_roles`, `list_tasks`, `load_internal_documents`,
`release_role`, `update_room_document`, `update_task`.
Note `create_room_document` / `update_room_document` are the schedule-persistence
path US-3 depends on, so US-3 cannot be built on `multi` until this is fixed.


Read this before enabling anything on this branch. Everything here is **written
and tested but connected to nothing** — which is safe only for as long as the
features that would need it stay off.

No known exploitable flaw is open. The one that existed — a forged DMARC pass
through a header our own infrastructure stamped — is fixed in `4aac1788` and has
a test reproducing the original attack. The entries below are undelivered
enforcement, not lurking bugs.

| # | Mechanism | State | What must not happen until it is wired |
|---|---|---|---|
| S1 | `disclosure.py` — `may_carry`, `disclosed_span` | **zero callers** | No outsider in a room with a multi-room agent. `handle_protection_verdict` in `bridge_core.py` is the intended call site and is still behind its TODO. |
| S2 | `email/authentication.py` — DMARC evaluation | **not imported by the adapter** | Email must not admit a sender who is not on the allowlist. The allowlist is the only live gate. |
| S3 | `email/reply.py` + SMTP | **not imported by the adapter** | Nothing. Outbound email does not exist, which is why S1 and S2 are not yet urgent. |
| S4 | `authenticates_senders` | **read only by a startup log line** | The addressing layer must not be described as distinguishing an unauthenticated sender. It does not. The warning reads like a control; it is not one. |

**The dependency that matters: S3 must not ship before S1 and S2.** Outbound
email is what puts an outsider in a room, and it is the reason the other two
exist. The design states this as a hard sequencing constraint; it is currently
satisfied only by S3 being absent.

**What is safe today.** An agent can span several internal rooms, and the
disclosure story for that is the designed one: rooms are labelled, the label
reaches the model on every event, and the flow rule is in the standing
instructions. That is "the boundary is visible", which is what Sprint 1 promised
and Sprint 4 was to reinforce. It is not enforcement.

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

---

## Sprint 5 — The agent has a correspondent

**Unlocks US-5**, once wired. `email/authentication.py`, `email/reply.py`.

This entry was missing when the log was first written — the sprint's decisions
were recorded in the review section and the commit messages, and nowhere
alongside the other four. Written up here for symmetry.

### Decisions taken during the work

**Only a DMARC pass authenticates.** Accepting `spf=pass and dkim=pass` as
equivalent is the tempting mistake: neither asserts that the envelope or signing
domain is the domain in the `From` line a person reads, and that alignment is
the only claim that matters when the answer decides who may address an agent.

**Exactly one `Authentication-Results` header is read — the one bearing the
configured `authserv-id`.** The header is ordinary text in an ordinary message,
so a sender can write one, and a receiver *prepends* its own, meaning the
attacker's arrives first. A deployment that has not configured the id gets no
verdict at all, which is right: mail that reached us by a path we cannot name
has been checked by nothing we can name.

**`Re:` exactly once, stripping any existing pile.** Prefixing unconditionally
produces `Re: Re: Re: Re: booking` after four turns, which is how a thread
announces that a machine is writing it.

**The full `References` chain, not just the parent.** Carrying only the
immediate parent attaches a reply to one message rather than to a conversation.

**Replying to a message with no `Message-ID` raises.** There is nothing to thread
against, and a reply claiming to answer nothing is worse than an error — it
arrives as a new conversation under a subject implying it is not.

**Both modules are pure and free of I/O**, so the fiddly parts are testable
without a mail server. Neither is wired into the adapter; see the safety
register.

---

## Review of Sprints 2–5

Two reviewers, split by subsystem. One confirmed a working exploit; the other
found the flow rule permitted the disclosure it exists to prevent. Both are
fixed in `4aac1788`.

### The two that mattered

**A forged DMARC pass — confirmed exploit.** `_METHOD` scanned the whole
`Authentication-Results` remainder, and `=` is legal in an address local part.
So `smtp.mailfrom=dmarc=pass@evil.example` puts the text `dmarc=pass` inside a
header **our own infrastructure genuinely stamped**, ahead of the real
`dmarc=fail`, and first-match-wins read the attacker's copy. Every other defence
in the module was bypassed by construction, because the header was authentic.

Now only the token at the head of each `;`-separated chunk counts as a verdict;
a repeated method fails closed rather than first-wins; an unset `authserv-id`
trusts nothing.

**`may_carry` compared audience *size*, never audience *identity*.** The
`source == target` shortcut returned True for `private`→`private` — one person's
DM into a different person's — and for `external`→`external`, one vendor's mail
into a rival's. That is the exact disclosure the module was written to prevent
and the most common shape a multi-room agent has.

The lesson is worth keeping: **an audience label is a size, and the question is
about people.** Two rooms sharing a label are almost never the same audience.
Without membership to compare, only two moves are soundly knowable — within a
room, and out of one the whole workspace can already read. Everything else needs
a person now. That is conservative rather than precise, deliberately: refusing
costs a question, permitting costs a disclosure.

The precise model is membership-set inclusion. Until Switch can compare
membership here, the rule stays blunt.

### The rule reached no agent at all

`_disclosure` shipped inside the `include_general` block — and all three
connector skills call `connect_to_room(..., include_general_instructions=False)`.
So the `audience` label reached the model on every event and the rule giving it
meaning reached nobody. Moved outside the gate: who can read *this room* is room
state, not general workflow, and a skill written once cannot carry it.

Its wording was wrong in two ways as well. "Do not quote or attribute" invited
the paraphrase — which is the leak — and the consent it asked for was the
permission of whoever the agent is talking to *now*, who is in the wider room and
cannot consent to hearing something they do not know exists.

### The divergence flagged last entry, resolved

The Sprint 4 entry proposed carrying a `bridge_external` boolean on the envelope.
The reviewer argued for sending the **audience itself**, and was right: the
boolean leaves `audienceOf`'s channel-type map as a second implementation of the
same rule, while the label deletes that side of it entirely.

Worse than recorded, too — both TypeScript call sites passed a literal `false`
under a comment claiming no bridge carried an outsider, which the email bridge
had already made untrue on the same branch. A required flag that can only be
answered by guessing collects guesses, so `bridgeIsExternal` is optional again
and absent now means `unknown` rather than `internal`.

### Everything else fixed

An empty `webhook_secret` made the inbound endpoint public (`prepare_config`
mints one at registration and nothing re-runs it on update) — `start` refuses
it. The secret reached the access log, since it is a path segment and aiohttp
logs the request line. `Auto-Submitted: auto-forwarded` is RFC 3834's value for
a *relayed human message* and was dropping every message in the deployment this
bridge is built for. `List-*` alone dropped a newsletter someone deliberately
forwarded. The loop check ran before the allowlist, letting a stranger choose
which warning they triggered. A handler failure was answered 202 and the mail
lost. Two `From` headers were admitted. Forward-as-attachment was discarded as
an undecodable attachment. A sub-ULP `everyMs` could spin forever.

### The pattern, again

**Six more tests were passing with the behaviour absent** — eleven across the
branch now. Two the reviewers proved: the malformed-bytes test never entered the
`try`/`except` it was named for (those bytes parse to a defective message, not
an exception), and the `Re:` test never saw a pile, so it passed with the
stripping loop replaced by an `if`.

Mutation testing each module after it goes green — neuter the guard, confirm the
tests go red — is now part of the process and caught several of these before
review. It did not catch these, because both tests exercised a *different*
correct path rather than no path at all.

### Still knowingly left

- The long-lived multi-room host (Sprint 1).
- D3's egress check is written but wired to nothing; `handle_protection_verdict`
  is still behind its TODO. The design's constraint — enforcement before an
  outsider is in a room — is therefore **not yet satisfied**, and Sprint 5's
  outbound path must not be enabled until it is.
- SMTP delivery, and wiring `authentication.py` / `reply.py` into the adapter.
- `authenticates_senders` is declared and warned about at startup, and nothing
  else consumes it. The startup warning reads like an enforced control; it is
  not one.
- No operator-facing way to see the minted webhook URL.
- The HTTP surface of the email adapter (`start`, routing, the 202/500 split)
  has no test coverage; every test goes through `bind_message_handler`.

---

## The multi-room host

Sprint 1's outstanding item, built after the Sprint 2–5 review.
`console/packages/switch-agent-runtime/src/host.ts`.

### What it is, and what it deliberately is not

The process that holds a `multi` connection open and stays up. **It does not
drive a model** — `onTurn` is injected — so what the module contains is only the
part with rules. That split is the reason it is testable at all: a host that
owned the model would need one to test.

### Decisions taken during the work

**Turns are serialised through a single promise chain.** One context window
means two turns in flight interleave two conversations inside it, and the agent
answers each with half of the other. A scheduled wake-up queues behind an event
like anything else — it is a turn in the same context, not a second thread of
thought.

**A turn that throws is logged, and the next one still runs.** One bad turn must
not silence the agent for the rest of the session.

**A wake-up aimed at a room the agent no longer holds is skipped, and the
schedule still advances.** Posting where it has no seat either fails somewhere
nobody reads or lands in a room it was evicted from; and a weekly recurrence is
due again next week whether or not this occurrence could run.

**The clock is injected.** Production passes `setTimeout`; a test advances time
by hand. Nothing in the suite waits on a real timer.

### A bug the tests found

`stop()` checked `running` *inside* the chained callback, so a turn accepted
before the stop but not yet started was discarded rather than finished — which
is precisely what `stop()` is documented not to do. Whether to accept work is
decided when it arrives; anything reaching the callback was accepted and is owed
completion.

Two of the tests also needed fixing during development: they asserted
synchronously, before the microtask a turn starts on had run, so they were
measuring "nothing has happened yet". That is the same vacuous-pass shape as the
other eleven on this branch, arriving through timing rather than through a weak
assertion.

### What review found

Four real bugs, three of them the same shape: **a check placed at the moment
work is accepted rather than the moment it runs.**

1. **`stop()` did not drain.** The wake-up cycle awaits a write before queueing
   the turns it found due, so awaiting the chain once returned through that
   window. The cycle now runs *on* the chain, and `stop` drains until the chain
   stops moving.
2. **The lost-room guard ran only at enqueue time**, so a turn queued behind a
   long one would reply into a room claimed away during the wait. The comment
   claiming otherwise was simply wrong.
3. **A gap was lost when the turn carrying it threw** — cleared before `onTurn`
   and never restored, so the agent answered from a stale picture with nothing
   saying so.
4. **A throwing logger could silence the host permanently**, being the one
   unguarded statement inside the chain.

Also added `evicted()`. The stream reports eviction and the host had nowhere to
put it; without it a host keeps firing scheduled work into rooms it was evicted
from while looking healthy.

**Three more tests asserted less than they read as** — ordering passed with the
serialisation removed, the wake-up-queues-behind-an-event test passed if the
wake-up never ran at all, and "rehydrates after a restart" contained no restart.
Fourteen across the branch now.

A related lesson: **the fake clock counted microtasks**, and that broke the
moment the wake-up path grew an `await`. A tick count is only ever right for the
current shape of the code, and the failure mode is asymmetric — the positive
test fails loudly while the negative one starts passing vacuously. Tests now
drain to quiescence through `settled()`.

And one about mutation testing: the first version of the drain test **passed
under the mutation**, because it asserted the turn had *started* rather than
finished. Mutation testing only works if the assertion can tell the difference.

### Knowingly left

- ~~Nothing wires this to `SwitchEventStream`~~ — **done**, see below.
- ~~No production `Clock`~~ — **done**, `systemClock` in `agent.ts`.
- **Reentrancy deadlocks.** `onTurn` calling `await host.deliver(...)` chains
  behind the turn currently executing and hangs. Undocumented, and the class is
  publicly exported.
- **`persist()` is last-writer-wins** across concurrent callers; the blast
  radius is restart-only.
- The safety register above is unchanged: the host makes a multi-room agent
  possible, which is the state Sprint 1 designed for (labels visible, rule in
  the instructions), but it does not wire D3.


---

## Wiring it up — a runnable agent

`console/packages/switch-agent-runtime/src/agent.ts`. Thirty lines joining the
stream to the host, and the first point at which anything on this branch can be
demonstrated rather than argued about.

### Decisions taken during the work

**It is its own module rather than a few lines in a caller.** The failure mode
of a missing wire is *silence*, which from outside is indistinguishable from a
quiet room, so each of the stream's four callbacks has a test asserting it lands
somewhere. `onEvicted` is the one that matters most: without it an agent keeps
its rooms and keeps firing scheduled work into them after another stream has
taken the connection over, receiving nothing and looking healthy throughout.

**The schedule is read before the socket opens.** Events arrive the moment it
does, and a turn that ran against an empty schedule which was then replaced
underneath it reads as a wake-up that silently went missing.

**`stop` waits for startup before aborting**, so a stop racing the open cannot
leave a stream nobody holds a reference to.

**The gap carries `fromSequence` through** into the message the agent sees. It
is the only thing saying how far back to re-read; without it the warning says
only that something, somewhere, was lost.

**`systemClock` repeats the `MAX_TIMER_MS` clamp** rather than leaning on
`nextDelayMs`. It belongs where the timer is: Node keeps a delay in a 32-bit int
and anything larger fires *immediately*, so any caller computing its own delay
would turn a monthly wake-up into a hot loop. Its `now()` is wall-clock
deliberately — a schedule is written in wall-clock terms — which does mean an
NTP step or a suspended laptop moves every pending wake-up.

All five wires were mutation-checked: cutting each one turns a test red.

### What this does and does not make possible

A process can now hold a `multi` connection across several rooms, answer in the
room it was addressed from, and wake itself on a schedule. **What it still needs
is an `onTurn` that drives a model** — that is the caller's, by design, and
there is no reference implementation of one here.

The safety register is unchanged. D3 remains unwired.


---

## Audit — what is and is not covered

Taken after the wiring landed, in answer to "is everything logged, reviewed and
tested?". The answer was no, in three places. Two are closed; one is open.

### Closed

- **Sprint 5 had no log entry.** Written above.
- **The disclosure section of the room instructions had no test.** This is the
  gap that let the "reaching no agent" regression exist for a sprint —
  `test_disclosure.py` tests the rule as a function, and its *delivery* was
  tested by nothing. `test_room_instructions_disclosure.py` now covers it, and
  reintroducing the original bug turns 11 of its 12 tests red.

### Closed since

- **`agent.ts` and every fix commit have now been reviewed.** See "Reviewing the
  corrections" below. Doing it found the original exploit still open.

### Open
- **Three behaviour changes have only incidental coverage**: the `audience`
  field on `RoomMeta` and its threading through nine envelope sites, the
  `authenticates_senders` startup warning, and the `surfaceMeta` wiring in
  `bin.ts` — the last of which cannot be unit-tested, since `bin.ts` exits at
  module scope.
- **Two environment gaps, unchanged since Sprint 1**: Postgres-backed core tests
  have never run here (testcontainers stalls), and the desktop app has no
  `node_modules`, so `switch-event-format.ts` and its tests are verified by
  inspection only. Both need a real run before merge.


---

## Reviewing the corrections

The audit above noted that no fix commit had been reviewed — roughly a thousand
lines of mostly security-relevant change, written immediately after a reviewer
said what was wrong, and then seen by nobody. Two reviewers were pointed at
exactly that, and told to look for incomplete fixes, over-corrections, and bugs
introduced by the fix.

**It was the highest-yield review of the branch.**

### The exploit was still open — twice

The DMARC forgery "fixed" in `4aac1788` remained exploitable by two other
routes, both demonstrated by execution:

1. **A quoted semicolon.** Anchoring the verdict to the head of a
   `;`-separated chunk is worth nothing if the sender chooses where chunks
   begin — and a quoted local part may legally contain a semicolon, so
   `smtp.mailfrom="x;dmarc=pass"@evil.example` invents a boundary and puts a
   forged verdict at the head of the chunk after it.
2. **A quoted authserv-id containing a space.** `_authserv_id` took the first
   whitespace token and stripped quotes afterwards, so `"mx.ours evil"` read as
   `mx.ours`. A border MTA strips a pre-existing header only on an *exact* match
   of its own id, so that header is never stripped — the attacker prepends it
   themselves and needs no MTA at all.

And a third route to the same place: a non-verdict like `dmarc=none` was
*skipped* rather than recorded, leaving the method unset so a later smuggled
`dmarc=pass` filled the gap. `dmarc=none` is the ordinary case for a domain
publishing no policy, so this was not exotic.

**The lesson, which is the one to keep:** the first fix addressed the *instance*
that was reported — a verdict pattern that matched too widely — and not the
*class*, which is that every part of that header after the authserv-id is
attacker-influenced text. A fix aimed at the reported input rather than the
threat leaves siblings behind, and here it left three.

### The rule contradicted itself in the permissive direction

`_disclosure` told the agent that repeating an `open` room's contents elsewhere
is free. `may_carry` refuses `open → external`. So the standing instructions
positively encouraged internal content going to an outside correspondent — the
single failure the section exists to prevent. The condition was on the source
room only; it is on both now.

### Sibling failures the corrections left behind

- `message/rfc822` flattening raised on a degenerate part *and* was unbounded in
  size. Both end as a 500 the provider redelivers forever, failing identically
  each time — a permanent retry loop introduced by a fix for silent data loss.
- The `List-*` branch was unreachable; the `Precedence` check above it always
  returned.
- `surfaceMeta` destructured without `audience`, so the server-computed label
  was dropped on **every** notification while the terminal path forwarded it.
  Two paths in one product disagreeing about a confidentiality label — and the
  fix had landed in `audienceOf` and not in its only caller.
- `bin.ts` read `event.audience` on a local type with no such field: a hard type
  error, hidden because vitest transpiles without checking.
- `onEvent` returned the turn promise, blocking the SSE reader for a whole turn
  — so `subscription_changed` could never arrive *during* one, making the host's
  queued lost-room re-check from the previous round unreachable through the
  wiring written right after it.
- A startup failure was an unhandled rejection nobody logged, and `stop` awaited
  `ready`, so a hanging `loadSchedule` was a process that could not shut down.

### Five more vacuous tests

Nineteen across the branch. Two worth naming: the two-`From` test passed because
the injected sender was unlisted, so the *allowlist* did the work and the count
check could be deleted with the test still green; and "aborts the stream and
drains the host" asserted only the abort — half its own title.

### What this says about the process

Reviewing implementations and not their corrections was a real hole, and it hid
a live exploit for two rounds. **A correction deserves the same scrutiny as the
code it corrects, and arguably more:** it is written fast, immediately after
being told one is wrong, with attention narrowed to the reported instance.


---

## What is actually load-bearing — and how to split this

Asked late, and it should have been asked early: **how much of this branch does
a demo need?** About 43% of the new source. The rest is correct, tested, and
ahead of demand.

Recorded here so the branch can be split into PRs by *dependency* rather than by
the sprint order it was written in.

### The four groups

**Group 1 — the multi-room protocol.** *Load-bearing. Nothing works without it.*

- `room_id` on `post_message`, `read_context`, `send_targeted_message`
  (`operations/definitions.py`, `operations/context.py`)
- `multi` scope, `Connection.claims_rooms`, `covers`, the delivery-loop park
  (`protocol/connections.py`, `protocol/stream.py`)
- scope/filter validation and its 400 (`api/handlers.py`)
- the three connector skills' `room_id` note

Self-contained, reviewed twice, useful on its own. **Land this first.**

**Group 2 — surfaces the agent can tell apart.** *Load-bearing for anything
multi-room, and for US-4's advisory half.*

- `surface.ts`, and `surfaceMeta` in `bin.ts`
- `audience` on the envelope: `RoomMeta`, nine `AgentEvent` sites,
  `protocol/types.py`
- `audience_of` / `bridge_is_external` / `EXTERNAL_BRIDGE_TYPES` in
  `disclosure.py`
- `_disclosure` in `instructions.py` and its test
- the audience in `switch-event-format.ts`

Depends on Group 1 being merged; otherwise independent.

**Group 3 — a session that spans rooms.** *Load-bearing for every demo.*

- `room-set.ts` and the `bin.ts` widening (`SWITCH_SCOPE`)

Small, depends on Groups 1 and 2. **This is the piece that makes it runnable**,
and it was found last.

**Group 4 — inbound email.** *Load-bearing for US-1 and US-6.*

- `bridges/collaboration/email/adapter.py`, its registration,
  `authenticates_senders` on the ABC, the lifecycle warning

Independent of 1–3 at the code level; only the demo needs both.

### What is ahead of demand

Correct and tested, connected to nothing, needed by no demo:

| | Lines | For |
|---|---|---|
| `host.ts` | 316 | a headless always-on agent |
| `agent.ts` | 158 | the same |
| `schedule.ts` | 167 | US-3, the only story needing the host |
| the `event-stream.ts` widening | — | the same — **`bin.ts` does not use `SwitchEventStream`** |
| `authentication.py` | 185 | Sprint 5, unwired |
| `reply.py` | 102 | Sprint 5, unwired |
| `may_carry` / `disclosed_span` | ~138 | D3, gated |

Land them as their own PRs, after the four above, and be explicit in each that
nothing calls them yet.

### Two things worth carrying forward

**`bin.ts` does not use `SwitchEventStream`.** It has its own stream loop. So
the `StreamScope`, `claim()` and `acceptRooms()` work on the shared client —
including a `repoint` takeover bug found in review — is used only by the console
watchers and by `host.ts`. Choosing that seam first was a wrong guess about
where the demo would run, and it was never checked.

**The most severe review findings were in the least-used code.** The DMARC
forgery, which survived three attempts, is in `authentication.py` — zero
callers. `may_carry` permitting one person's DM into another's is in the unwired
half of `disclosure.py`. The email adapter is necessary and had real bugs too,
so it is not a clean split — but a large share of four review rounds went to
code no demo touches.

The predictable shape, and an argument for building closer to demand: **Sprint 1
should have been followed by an attempt to run it**, not by Sprint 2. That one
step would have surfaced the `bin.ts` route, shown `event-stream.ts` was the
wrong seam, and said whether the protocol change works — all before Sprints 3
and 5 and the host existed.


---

## The smoke test — it ran

First execution of anything on this branch, against a real stack: Postgres,
Tuwunel and switch-core from this working tree. Two internal rooms, no bridge,
one connection. Driven with `curl` rather than a session, because the protocol
change is what had never run.

**Everything passed.** Six behaviours, each previously only asserted in a test:

1. `scope=multi` is accepted, and `connection_state` comes back naming **both**
   rooms as claimed on the one connection.
2. Messages posted in *both* rooms arrive on **that single stream**, each
   tagged with its own `room_id`. This is the whole design working.
3. `post_message(room_id=A)` lands in A and not in B — verified by reading both
   rooms back.
4. `post_message` with no `room_id`, holding two rooms, is refused: *"This
   connection covers several rooms; the operation needs one — pass room_id
   explicitly. Rooms covered: [...]"*, naming both.
5. `post_message` naming a room outside the claimed set is refused.
6. The `audience` label is on the envelope, computed server-side —
   `"audience":"open"` for these rooms, which is right: `create_room` defaults
   to `channel_public`, and an internal Switch room is workspace-visible.

### Two things the run taught that the tests did not

**An agent's own messages are not delivered back to it.** Obvious in hindsight
and not written down anywhere; it cost a diagnostic cycle. A delivery test needs
a second speaker, which means a second agent with a connection of its own.

**`room_id` does not substitute for being connected.** The first attempt had the
second agent post with `room_id` and no connection, and got *"Not connected to a
room."* That is correct — `session_key()` gates before the room is resolved, and
a room id is an argument rather than a permission — but it is worth knowing
before writing a harness.

### What it did not cover

No bridge, so no Slack and no email. No Claude Code session, so the `bin.ts`
widening is still unexercised: `SWITCH_SCOPE`, `RoomSet` and the reconnect
declaration are tested but have never run. That needs a built runtime, which
needs a `pnpm install` this environment cannot do.

So: the **server half of Sprint 1 is proven**, the client half is not.

---

## 2026-09-06 — standalone run, client built, and two runbook errors

First run on the **standalone** stack (everything in Docker, built from the
working tree) rather than host mode. Steps 1–4 of the runbook now carry
`[verified]` for that configuration too.

### What ran

- `pnpm install && pnpm -r --filter './packages/**' run build` — four packages,
  `dist/bin.mjs` at runtime **0.6.0**. First time the client has been built at
  all; every client-side finding before today came from reading.
- `just standalone-up` — images built from the tree, `/health` 200, gateway 200.
  No migration step: `switch_core.main` runs `alembic upgrade head` on boot.
- Agent registered; two internal rooms created.
- A `multi` SSE stream with a 2s heartbeat loop reported
  `"scope":"multi"` with **both** room ids and `cursor:4`.
- The three routing cases again, unchanged from the host-mode run: a routed
  post succeeds, an unaddressed post is refused as ambiguous naming both rooms,
  and a post naming an unheld room is refused naming what the caller does cover.

### Two errors in the runbook, both found by following it

**The env var is `SWITCH_API_TOKEN`, not `SWITCH_API_KEY`.** The runbook said
`SWITCH_API_KEY` because that is the field name in the *registration response*.
Nothing reads it. `bin.ts` reads `SWITCH_API_ENDPOINT`, `SWITCH_API_TOKEN`,
`SWITCH_AGENT_ID`, `SWITCH_SCOPE`, `SWITCH_CONNECTION_ID`,
`SWITCH_CHANNEL_DISABLE_POLL`. With the token absent the runtime does not fail —
it falls back to resolving against a `.switch/agents/` store, which a scratch
directory does not have, so the failure surfaces as a credential error naming a
directory the user never chose.

**The connector plugin is not needed for this demo,** which the runbook implied
by warning about its npm pin without saying the pin could simply be avoided. The
runtime delivers room events to Claude Code directly as
`notifications/claude/channel`; the plugin's `PostToolUse` hook is a *second*
path to the same place. Installing the plugin here would reintroduce the 0.3.3
pin — the exact failure the step warns about. A bare `.mcp.json` naming
`dist/bin.mjs` is both simpler and the only way to be sure 0.6.0 is running.

### Unchanged

The safety register is untouched: D3 is still unwired, `authentication.py` and
`reply.py` are still unimported, and outbound email still does not exist. Nothing
today touched any of them.

Still unexercised: the client half. `SWITCH_SCOPE`, `RoomSet` and the reconnect
declaration are built and unit-tested but have not yet run inside a session.
That is Step 6, and it is the first thing that proves the client half at all.

### The harness cannot be the second speaker — and finding that out was a result

Step 6 failed on the first try with *"Not connected to a room."* from the
harness connection, which looked like a dead heartbeat. It was not: both
processes were alive, the SSE stream was receiving keepalives, and a manual beat
returned `{"ok":true,"rooms":[],"cursor":4}` — the connection existed and held
**nothing**.

The Claude Code session had claimed both rooms away from it. That is the room
slot invariant — *at most one connection per (agent, room)* — doing exactly what
it is for. The runbook had said to keep the Step 4 stream running as Step 6's
second speaker, which cannot work: it is the same agent.

The fix is a second *agent*. `probe`, invited to both rooms by `atlas`, with its
own `multi` connection. Both agents then hold both rooms, because the invariant
is per-agent rather than global.

**This is the first evidence that the client half works.** The harness held both
rooms; after the session started it held neither. Under `single` the session
could have taken only one of them and the harness would have kept the other. It
lost both — so the 0.6.0 runtime, under `SWITCH_SCOPE=multi`, claimed two rooms
on one connection. `RoomSet.adopt` not releasing under `multi` is the line that
does it, and it had never run before today.

The session-side confirmation — that both rooms are visible to the model and
that a reply routes back to the room it came from — is still outstanding.

### The session claimed both rooms — and then could barely act

Server logs, the first time the client half has ever run:

```
[CONNECT] connection=faab6976… took room 09590cc2… from connection t
[CONNECT] connection=faab6976… took room 4e8f635f… from connection t
```

**One connection, `scope=multi`, holding two rooms.** That is Sprint 1's central
claim, executing rather than asserted. `RoomSet.adopt` not releasing under
`multi` is the line that does it.

Two things went wrong on the way, and both are worth keeping.

**Registration defaults to owner-only addressing, so the second speaker was
refused.** `probe`'s `@atlas` was demoted to room chatter and answered with *"my
operator has restricted who can address me here."* Both agents share an owner —
the registration token's user — and the default rule carries
`owner_agents: false`. The fix is the documented one for owner-run
orchestration: `PUT /gateway/agents/{id}/addressing-policy` with
`owner_agents: true`, which admits the owner's own agents and leaves human
owner-only addressing intact. Clearing the policy would also have worked and is
worse: it opens the agent to anyone.

This is not a demo-only detail. It applies to the Slack demo too — a human
addressing `atlas` must be its owner, which means their Slack account has to be
linked to the owning Switch user. An unlinked account gets a *different*
refusal naming that specific cause.

**Then the session hit D4** (above): it called `read_context` and
`list_participants` with no `room_id`, was told to pass one, and for
`list_participants` there is no such parameter. So a `multi` session can talk
and read, and can do almost nothing else. That is the gap to close next, and it
is larger than the three operations the design treated as the room-addressed
set.

---

## 2026-09-06 — D4 fixed: the room-addressed surface is now structural

### What changed

The 19 operations split cleanly in two, and the split is the fix:

- **14 act on a room** — they bind the resolved room and use it. Each now takes
  an optional `room_id` and passes it through: `list_references`,
  `list_linked_rooms`, `load_internal_documents`, `create_room_document`,
  `update_room_document`, `delete_room_document`, `list_participants`,
  `delegate_task`, `list_tasks`, `list_roles`, `define_role`, `edit_role`,
  `delete_role`, `assume_role`.
- **5 only need the caller to be somewhere** — they resolved a room and threw
  it away: `accept_task`, `update_task`, `finalise_task`, `cancel_task`,
  `release_role`. These call a new `require_connected()` and take **no**
  `room_id`. Demanding an id that is then discarded is an argument a caller
  cannot reason about, and it was the reason an agent on two surfaces could
  take a role and be unable to release it.

The tool schema is derived from the signature, so both front doors and the
runtime — which fetches the operation list from the server at startup — pick
the new argument up with no client change.

### Why the tests are written the way they are

The bug was not "three was the wrong number to widen". It was that *which
operations take a room* lived in a human's memory, so the set went stale the
first time someone added an operation. The tests now derive the two sets from
an AST walk of `definitions.py` and assert the rule over each, so operation
number 26 is covered without anyone remembering this existed.

That style has one failure mode — a scan that matches nothing passes
vacuously — so `test_the_source_scan_actually_found_operations` pins minimum
sizes and asserts the two sets are disjoint.

Red first, for the right reasons: 33 failures, being the 14 room-acting
operations × 2 structural assertions plus 5 behavioural. Then green.

### Verified live, not just in tests

Against the rebuilt standalone image, on a connection holding two rooms:

- `list_participants(room_id=…)` returns that room's members — it was
  uncallable an hour earlier;
- `list_participants()` with no room still refuses, naming both rooms;
- `list_participants(room_id=<unheld>)` still refuses;
- `release_role()` succeeds while two rooms are held.

### Cost

`post_message`, `send_targeted_message` and `read_context` are no longer a
special case, so the three connector skills lost the sentence enumerating them
and gained the general rule. All three plugin versions bumped and
`artifacts.yaml` regenerated.

2226 core tests, 199 runtime tests, full console typecheck, `ruff` and `mypy`
clean. One desktop failure in `sidecar/session-spawner.test.ts`, pre-existing
and machine-specific: it reads this machine's real `~/.claude.json`.

### Why the session was deaf — and how it was settled

The session could `read_context` a room and see the messages, and was never
woken by them. Both halves looked fine, which is the worst shape a bug can have.

Settled by experiment rather than reading: a third agent, the runtime driven
under a **minimal MCP stdio client** (`initialize`, `connect_to_room`, then
print every notification). It emitted exactly what it should:

```
>>> NOTIFICATION notifications/claude/channel
{"content": "[probe]: @echoprobe are you notified?",
 "meta": {"room_id": "…", "audience": "open", "event_type": "message", …}}
```

So the server buffers, the stream delivers, and the runtime notifies —
including the `audience` label this branch added. The gap is entirely on the
host side: **Claude Code surfaces `notifications/claude/channel` only from a
plugin-provided MCP server.** Registered from a project `.mcp.json` the server
connects, claims its rooms, serves every tool — and nothing ever wakes the
session.

An earlier entry here claimed the plugin was unnecessary because the runtime
notifies Claude Code directly. The first half is true and the conclusion was
wrong. There was also a name collision: a project server called `switch` and
the plugin's server called `switch`.

The fix for a demo is to point the *installed* plugin at the local
`dist/bin.mjs` rather than its npm pin, and to remove the project server. That
keeps 0.6.0 running while getting the channel registration only a plugin has.

**Worth carrying beyond the demo:** the npm pin and the plugin are not two
independent facts. A client change cannot be exercised in a real session at all
until it is either published or hand-substituted into an installed plugin, so
"unpublished" is closer to "untestable end to end" than the version table
suggests.
