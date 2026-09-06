# Demoing the multi-surface agent

What can be shown from `feat/multi-surface-agent`, what cannot, and what has to
be built or stood up first. Companion to `multi-surface-agents.md` (the design)
and `multi-surface-progress.md` (what happened).

**The one-line summary:** four of the six user stories are demonstrable, one is
demonstrable only if you say out loud what is missing, and one is not
demonstrable at all. Nothing runs yet, because nothing drives a model.

## What can be shown

| Story | Demonstrable | Needs |
|---|---|---|
| US-2 continuity across surfaces | ✅ fully | two rooms on **existing** bridges |
| US-1 one agent, several surfaces | ✅ fully | email inbound: a domain, a provider, a public endpoint |
| US-3 agent chooses how to reach me | ✅ fully | nothing beyond the harness |
| US-6 recognised as me | 🟡 the allowlist half | email inbound |
| US-4 discretion | 🟡 the *soft* half only | say what is missing — see below |
| US-5 outsider on their terms | ❌ not at all | outbound email, which does not exist |

### US-4 — what you may and may not claim

The agent is **told** who can read each room and what may be repeated where.
That is real and it is worth showing: the label reaches the model on every
event, and the flow rule is in its standing instructions.

**Nothing enforces it.** `disclosure.py` has no callers; the egress check is
written and wired to nothing. So a demo shows a model behaving discreetly
because it was asked to, not a system preventing a leak.

Show it, and say that sentence. Demoing it as enforcement would be a lie, and a
discoverable one — the first person to try an adversarial prompt finds out.

### US-5 — why not

Outbound email does not exist. `reply.py` builds a correctly threaded reply and
nothing sends it; there is no SMTP path. An outsider can be *heard* today (see
the allowlist note below) but cannot be *answered*.

## Blocking prerequisites

Neither has ever run in the development environment used so far. Both are
cheap for someone with a working setup, and both could invalidate the rest.

- [ ] **Postgres-backed core tests.** `just test` with Docker reachable. ~193
      tests have never executed here — testcontainers would not start a
      container. Store and integration coverage is entirely dark.
- [ ] **Console typecheck and desktop tests.** `pnpm typecheck` and
      `pnpm test` from `console/`. TypeScript has **never** been typechecked on
      this branch. Review already found one hard type error that 155 green
      vitest tests hid, because vitest transpiles without checking.

## What still has to be built

The mechanisms are done. The thing that turns them into an agent is not.

- [ ] **An `onTurn` implementation.** *(the blocker — nothing runs without it)*
      `startMultiRoomAgent` takes it and there is no reference version. It has
      to: take a `Turn`, optionally `read_context(room_id)`, build a prompt,
      call a model, and `post_message(room_id=…)`. Agent operations are
      reachable over plain HTTP (`POST /ops/{operation}`), so it needs no MCP.
      Small — a few hundred lines — but it is the whole difference between
      plumbing and an agent.
- [ ] **Schedule persistence.** `loadSchedule` / `saveSchedule` are injected and
      unimplemented. They should call `create_room_document` /
      `update_room_document` over the same HTTP surface. Only needed for US-3.
- [ ] **A launcher.** Something that reads credentials, builds the deps and
      calls `startMultiRoomAgent`. A script, not a product.

## Three tiers

Each adds exactly one thing to the one before it. Stop at any of them.

### Tier 1 — two rooms, one mind *(US-2)*

**No new infrastructure.** Switch already has five collaboration bridges; the
multi-surface claim does not need email to be true.

- [ ] Register an agent; note its id and token
- [ ] Put it in two rooms on bridges you already run — a Slack channel and a
      Telegram DM is the convincing pair; a Slack channel and a Slack DM is the
      cheap one
- [ ] Launch with `rooms: [both]`, `scope: multi`
- [ ] Confirm on the server that one connection claims both rooms, and that the
      auto-session watcher has gone dark on them

*Acceptance:* three exchanges deep in the channel, then continue from the DM.
The agent knows what "it" refers to and answers where you asked.

*Watch for:* two sessions instead of one — a `single` connection claiming a room
away is the failure this design exists to prevent, and it looks like the agent
going quiet in one room.

### Tier 2 — an inbox *(US-1, and US-6's allowlist half)*

- [ ] A domain and an inbound-parse provider (Postmark, Mailgun, SendGrid) — any
      that can POST the **raw RFC 5322 message**, which is what the adapter
      takes
- [ ] Switch reachable from that provider, and the adapter's listener port open
- [ ] Register the email bridge; the webhook secret is minted at registration
      and forms the URL path
- [ ] Put **only your own addresses** in `allowed_senders`
- [ ] Forward one mail and confirm a room is auto-created for you

*Acceptance:* forward an email from your phone with no note. Later, in Slack,
ask about it. It answers. Forward from an unlisted address and it refuses, out
loud, in the log.

*Watch for:* everything being dropped. `Auto-Submitted: auto-forwarded` was
dropping every message until recently, and a server-side forwarding rule is
exactly what sets it.

### Tier 3 — it wakes up *(US-3)*

- [ ] Implement `loadSchedule` / `saveSchedule` against a room document
- [ ] Have `onTurn` schedule something — a digest a few minutes out
- [ ] Restart the process before it fires

*Acceptance:* it posts unprompted, in a room it chose, at the time it set. It
survives the restart with the schedule intact.

*Watch for:* a wake-up firing repeatedly. That is the clamp or the missed-
recurrence logic, both of which have tests, but neither has run against a real
clock over a real interval.

## Say these out loud

A demo that overclaims is worse than a smaller one. Three things to state:

1. **US-4 is advisory.** The agent is told the rule; nothing checks it.
2. **The email allowlist is a plain config list**, not identities anyone has
   claimed. The design specified `ExternalUserClaim`; the code takes any string.
   So "it knows it's me" is really "an operator listed this address".
3. **No outsider can be answered.** Inbound only.

## The order I would do it in

1. The two prerequisites, because they can invalidate everything below.
2. `onTurn` plus a launcher — Tier 1 needs no infrastructure and proves the
   central claim.
3. Tier 2, which is the story most people came for and the one with real setup
   cost.
4. Tier 3, cheapest of the three once the harness exists.

Tier 1 is worth doing on its own even if nothing else follows: it is the first
time any of this executes, and everything found so far was found by reading.
