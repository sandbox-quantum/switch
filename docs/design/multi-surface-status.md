# Where this branch stands

Written after the first real use of the system, to answer three questions
before the next phase: **what is the actual user story**, **which code is
load-bearing**, and **what is written but reaching nobody**.

Companions: `multi-surface-agents.md` (the design), `multi-surface-demos.md`
(what to show), `multi-surface-progress.md` (the running log and the safety
register), `multi-surface-runbook.md` (how to stand it up).

---

## 1. The user story that actually emerged

The design doc has six stories. The first unscripted session used the system
for something none of them quite describes — an **intelligence desk**:

> Through the day I forward things to my agent by email — newsletters,
> articles, a rumour I heard. It reads them, **checks them**, and keeps a
> running picture. Later, in Slack, I ask "what's happening in AI right now?"
> and it answers from work it has already done.

What was actually done, in one sitting:

- Four newsletters forwarded by email, each asked for a summary.
- A rumour forwarded by email, which the agent **researched, debunked** and
  then filed "as a debunk, not a story" rather than dropping.
- A **running list** maintained across messages: *"one to add to the list"*,
  *"five more for the list"*.
- The list queried **from Slack**, repeatedly, as the day went on.
- A **standing instruction** given in Slack: *"whenever i send you an email, i
  want you to acknowledge"* — after which each email got an ack in Slack.

This is US-1 and US-2 in substance, but the emphasis is different in three ways
the design did not anticipate:

1. **Accumulation over time matters more than a single hand-off.** The value is
   the running picture, not one question answered on another surface.
2. **The agent verifies rather than relays.** It web-searched every forwarded
   claim and corrected two of them. Nothing in Switch does this — it is the
   model — but the workflow depends on it.
3. **Standing instructions are part of the interaction.** The user configured
   behaviour conversationally, in a room.

### What that session exposed

**a. The disclosure rule blocks the primary use case, and the user routed
around it by hand.** Asked in Slack about a forwarded newsletter, the agent
refused. The user replied *"paste it here and from now on please do not
restrict yourself"*, and the agent negotiated a narrower rule itself:

> "On the standing rule: agreed, and dropped for published material.
> Newsletters, articles, reports, analyst notes — anything already published to
> an audience — I'll summarize here without asking."

That is the right rule and the agent invented it. `may_carry` has no concept of
*published* content, and no way to record a decision like this. **Design input:
the audience of the content matters as much as the audience of the room.** A
newsletter in an `external` room is not confidential; a vendor's quote in the
same room is.

**b. Standing instructions live only in the context window.** *"Whenever I send
you an email, acknowledge it"* is honoured for as long as the session lives and
is gone on restart. Switch has the machinery to persist it — room documents,
`update_agent_detail` — and nothing connects the two.

**c. The 16 KB cap bit on the first real forward,** exactly as D5 predicted:

> "note it arrived **truncated**: the bridge caps a message at 16 KB and yours
> was cut off mid-sentence… So I have roughly the first half."

**d. Cross-surface acknowledgement works and is the demo.** Email arrives, the
agent posts a one-line ack in Slack naming what came in, and keeps the contents
where they belong. That is the whole multi-surface claim in a single visible
behaviour.

---

## 2. Which code is load-bearing

Everything in this section is exercised by the running system. Removing any of
it breaks something observable.

### Server — the `multi` scope and room addressing

| File | Why |
|---|---|
| `protocol/connections.py` | `Scope = single \| multi \| all`, `claims_rooms`, validation at `open()` |
| `protocol/stream.py` | the park guard, which reads `claims_rooms` rather than `scope == "single"` |
| `api/handlers.py` | removing a duplicate hard-coded validator that made `multi` **unreachable** |
| `operations/context.py` | `_covered_rooms`, `_resolve_room`, `require_connected_room(room_id)`, `require_connected` |
| `operations/definitions.py` | `room_id` on the 17 room-acting operations, `require_connected` on the 5 that only need a binding, `list_rooms` reporting every held room |
| `protocol/service.py` | role presence by membership rather than `len(rooms) == 1` |

### Server — audience labelling

| File | Why |
|---|---|
| `disclosure.py` — **`audience_of` + `bridge_is_external` only** | 2 call sites each; the labels every event carries |
| `protocol/types.py`, `clients/room_meta.py`, `clients/agent_client.py` | computing `audience` server-side and putting it on the envelope |
| `protocol/instructions.py` | the only reason the rule reaches the model at all |

### Server — the email bridge

| File | Why |
|---|---|
| `bridges/collaboration/email/adapter.py` | the bridge. Inbound webhook, allowlist, loop protection, the 16 KB cap |
| `bridges/collaboration/adapter.py`, `lifecycle_service.py` | `authenticates_senders`, which drives the "this bridge does not verify identity" warning |
| `main.py` | registers it |

### Client — the runtime

| File | Why |
|---|---|
| `src/room-set.ts` | adopt-without-releasing under `multi`; the reconnect declaration |
| `src/surface.ts` | turns the server's `audience` into the label the model reads |
| `src/bin.ts` | `SWITCH_SCOPE`, the room set, per-event room routing |
| `src/event-stream.ts` | `multi` on the wire |

### Client — Switch Console

| File | Why |
|---|---|
| `switch-rooms/room-connection.ts` | a managed session holding several rooms; per-room runtime state; per-event media and control routing |
| `switch-rooms/switch-notification-poller.ts`, `sidecar/sidecar-runtime.ts` | its two callers |
| `switch-rooms/switch-room-service.ts`, `shared/…/switch-rooms.ts`, `switch-rooms/auto-session-watcher.ts` | the spawn guard. **Without this a ping in a non-primary room starts a second session** |
| `switch-rooms/switch-event-format.ts` | the audience label in the injected text |
| the three connector `SKILL.md` files | told the agent "one room at a time", which it believed and acted on |

### Infrastructure

`deploy/local/standalone-email.override.yml` publishes the bridge's port.
`scripts/email-imap-poll.py` is demo tooling, not product — it stands in for an
inbound-parse provider.

---

## 3. Which code reaches nobody

**1,072 lines of source and roughly 2,000 of tests have no caller.** All of it
passes, none of it runs. Every piece maps to one unbuilt story, so the honest
label is *not yet reachable* rather than *dead* — but nothing today would
notice its absence.

| Code | Lines | Blocked on | Story |
|---|---|---|---|
| `disclosure.may_carry` + `disclosed_span` + `_words` | 91 of 198 | a product decision on what enforcement means, now complicated by §1a | **US-4** enforcement (D3) |
| `email/authentication.py` | 207 | wiring into the adapter | **US-6** real sender verification |
| `email/reply.py` | 102 | there is no SMTP path | **US-5** answering an outsider |
| `runtime/host.ts` | 347 | no launcher constructs it | **US-3** self-scheduling |
| `runtime/schedule.ts` | 167 | same | **US-3** |
| `runtime/agent.ts` | 158 | same | **US-3** |

Their tests: `host.test.ts` (709), `agent.test.ts` (340), `schedule.test.ts`
(279), `test_email_correspondent.py` (397, covers `authentication` and `reply`),
and 42 of 288 lines in `test_disclosure.py`.

**Two things follow from this that are easy to miss.**

The **US-3 cluster is self-consistent and self-contained**: `agent.ts` imports
`host.ts` imports `schedule.ts`, and nothing outside imports any of them. It is
a complete, tested implementation of a feature with no entry point. It was
built to a design that later turned out to need a launcher nobody wrote.

The **`disclosure.py` split is the one place where wired and unwired code share
a file**. `audience_of` and `bridge_is_external` are load-bearing; `may_carry`
and `disclosed_span` are the enforcement half and have zero callers. Reading
the file, it looks like a working disclosure system. It is a working *labelling*
system next to an unused rule.

---

## 4. What the next phase should probably do first

In the order the evidence supports, not the order the design doc assumed:

1. **D5 — read forwarded mail properly.** It is the primary use case and it is
   broken today: a forward is flattened to raw MIME, capped at 16 KB, and its
   attachments never reach the agent. Confirmed by the first real use.
2. **Decide what `may_carry` is for.** The current rule blocks the actual
   workflow and the user overrode it conversationally. Either narrow it to
   content that is plausibly confidential, or make an override something the
   system can record. Until then, D3 enforcement should not be built on it.
3. **Persist standing instructions.** Room documents already exist. Nothing
   connects a "from now on…" said in a room to anything durable.
4. **Then** US-3, US-5, US-6 verification — each of which already has its code
   written and waiting.

---

## 5. Splitting this into PRs

**Do not cherry-pick.** Eight commits touch three or more trees at once — the
review-fix commits each span server, runtime, console, skills and
`artifacts.yaml`, because that is what fixing a finding across a stack looks
like. Any commit-range split leaves half a change behind.

**Reconstruct by file instead.** Branch from current `main` and
`git checkout feat/multi-surface-agent -- <paths>`. The history here is
test → implement → fix-review, which is no use to a reviewer; the reasoning
lives in these design docs.

| PR | Contents | Depends on | Ready? |
|---|---|---|---|
| **1. `multi` scope + room addressing** | `protocol/{connections,stream,types}.py`, `api/handlers.py`, `operations/{context,definitions}.py`, `protocol/service.py`, their tests, `docs/old/api/AGENT_PROTOCOL.md` | — | **yes** |
| **2. audience labelling** | `disclosure.py` (wired half), `clients/{room_meta,agent_client}.py`, `protocol/instructions.py`, runtime `surface.ts`, console `switch-event-format.ts`, tests | 1 (conceptually) | after §4.2 |
| **3. runtime client** | `room-set.ts`, `bin.ts`, `event-stream.ts`, `index.ts`, `types.ts`, tests, the three `SKILL.md`, plugin versions, `artifacts.yaml` | 1 | yes, but needs the npm tag |
| **4. Switch Console multi-room** | `room-connection.ts`, `switch-notification-poller.ts`, `sidecar-runtime.ts`, `switch-room-service.ts`, `shared/…/switch-rooms.ts`, `auto-session-watcher.ts`, tests | 1, 3 | yes |
| **5. email bridge** | `email/adapter.py`, `collaboration/adapter.py`, `lifecycle_service.py`, `main.py`, `test_email_adapter.py`, the deploy override, `scripts/email-imap-poll.py` | 1 | **hold for D5** |
| **6. the unwired code** | `may_carry`/`disclosed_span`, `email/authentication.py`, `email/reply.py`, `agent`/`host`/`schedule`.ts and their tests | its own story | **do not submit** |

### Order and timing

**PR 1 can go whenever.** It imports neither `disclosure` nor `email`, it is the
most heavily exercised code here, and neither pending decision touches it.
Landing it early removes about a third of the branch and de-risks the rest.

**PRs 2 and 5 should wait** on the two decisions in §4 — otherwise they are
written twice.

**PR 3 carries a release step**, not just a merge: the connector pins must name
a *published* runtime, so the tag (`git tag switch-agent-runtime-v<version>`)
goes first and the pins follow. Until then no session runs the new client.

**PR 6 should not be submitted as code.** Each piece is a complete tested
feature with no entry point, and a reviewer would read it as live. It belongs
with the story that gives it a caller.

### Two things to do before any of it

- **Rebase onto `origin/main`.** The branch is behind, and the connector
  versions were computed from stale values once already.
- **Re-run the whole gate on the rebased tree**, since nothing here has been
  tested against current `main`.
