# Multi-surface agent — demos you can actually run

Three demos, each built only from behaviour that has been observed working, with
the exact thing to say where the honest answer is "not yet". Setup is
`multi-surface-runbook.md`; this is what to do once it is up.

Every quote below is a real message an agent posted during testing, not an
illustration.

---

## Read this first: the headline scenario does not work

The feature was written around a scenario from the original brief:

> forward it an email and then ask about that email in Slack

**The agent refuses to do that**, and it is right to. US-4's disclosure rule
permits content to move only within the same room, or *out of* a workspace-wide
`open` room into somewhere smaller. An email room is `external`, so its contents
travel nowhere. Asked in a Slack channel about a forwarded email, the agent
said:

> "There is separate email correspondence I'm party to, but it's a DM with
> someone outside the organisation, and this room is open to the whole
> workspace — so the contents don't travel here, including the deadline.
> Summarising it would be the same disclosure as quoting it."

So the strongest capability and the planned headline are in direct tension. Do
not plan a demo around the original wording; **Demo B turns the refusal into the
point**, which is a better story and a true one.

The gap is narrower than it first looks and is written up as a design question
rather than a bug — see the D5 and disclosure sections of
`multi-surface-progress.md`. Refusing in an *open channel* is correct in any
design. What is missing is that the rule reasons about room audiences and has no
notion of *who is asking*, so it cannot tell that you asking about your own
forwarded mail discloses nothing.

---

## Status by user story

| Story | | What is real |
|---|---|---|
| **US-1** one agent, several surfaces | 🟡 | Reachable on four rooms across Slack, email and internal, one context, answers where asked. The cross-surface *reference* half is blocked by US-4. |
| **US-2** continue somewhere else | ✅ | Proven between rooms the rule permits. |
| **US-3** agent chooses how to reach you | ❌ | Not built. Needs `MultiRoomHost` and schedule persistence. |
| **US-4** discretion | ✅ | Demonstrated twice, unprompted. **Advisory — nothing enforces it.** |
| **US-5** outsider on their terms | ❌ | Inbound only. An outsider can reach the agent and cannot be answered. |
| **US-6** recognised as me | ✅ | Both halves: the right sender admitted, the wrong one refused, in two distinct ways. |

---

## Demo A — one agent, four surfaces, one context

**Shows:** US-1's reachability, US-2's continuity. **~4 minutes.**

The agent is in a Slack channel (`restricted`), an email thread (`external`) and
two internal rooms (`open`), on **one session with one context window**.

1. **Show the session.** One Claude Code window. Not four.
2. **Post in Slack:** `@atlas what other rooms are you in?`

   It answers in Slack, naming them. Actual reply:

   > "Connected right now: this channel and **t-alpha**. I'm also a member of
   > **t-beta** but not live in it at the moment... Beyond those I'm party to one
   > email DM with someone outside the organisation."

3. **Post in an internal room:** `@atlas which room did this arrive in?` — it
   answers *there*, correctly, without being told.
4. **Send an email** to the agent's address. The same session wakes on it.

**Say:** the session is woken by each surface and replies to the one that asked;
nothing is polling and nobody re-explained anything.

**Watch for:** the Switch Console badge shows **one** room while the session
serves four. Known and cosmetic — `session_room_connections` keys on the
session. Say it before someone notices.

---

## Demo B — it knows what not to repeat

**Shows:** US-4. **~3 minutes. The strongest thing built.**

1. **Send the agent an email** with something specific and confidential — a
   renewal deadline, a number.
2. **In the Slack channel, ask about it:** "something came in by email about a
   renewal — what does it need, and by when?"
3. **It declines**, and explains itself. Real reply:

   > "The permission to repeat it isn't mine or yours to give; it belongs to the
   > people in that thread. If you need it, the routes are to ask them directly,
   > or to have my operator relay it deliberately."

4. **Then show the second, unprompted one.** Asked in Slack to list its rooms, it
   volunteered:

   > "I'll leave them unnamed here: who an outside correspondent is belongs to
   > that thread, not to this channel."

   Nobody asked it to be careful. It had the audience label and drew the
   conclusion.

**Say — and do not skip this:** *this is advisory.* Every room carries an
audience label (`open`, `restricted`, `private`, `external`) that reaches the
model on every event, and the flow rule is in its standing instructions.
**Nothing enforces it.** The enforcement is written (`disclosure.py`) and wired
to nothing. You are watching a model being discreet because it was asked to, not
a system preventing a leak. The first person to try an adversarial prompt will
find that out, so say it before they do.

---

## Demo C — recognised, or refused, and it says which

**Shows:** US-6. **~3 minutes.** Two independent gates, each failing in its own
words.

1. **Send from an address not on the allowlist.** Nothing appears. The log:

   > `[EMAIL] refused mail from … — not an allowed sender`

   During testing this fired on its own: Google's account-setup notices to the
   demo mailbox were refused without anyone arranging it.

2. **Send from an allowlisted but unclaimed address.** The mail is admitted and
   the agent still refuses:

   > `has not been claimed by any Switch user, so an owner-scoped rule cannot
   > match them — the owner may need to link this identity`

3. **Claim the identity** (`POST /gateway/collaborations/{id}/identities`), send
   again — it answers.

**Say:** two gates, deliberately. "The bridge let it in" and "the agent may be
addressed by you" are separate decisions, so an operator can admit a
correspondent without making them the agent's owner.

**Say also — this is the honest caveat:** for email, the sender is **not
verified**. The bridge logs it at startup:

> *"the identity on an inbound message is a claim the platform did not verify"*

A `From` header is trivially forged and nothing checks DMARC here. Email
recognition rests on the allowlist plus your mail provider. Slack's identity is
genuinely stronger. Do not let the demo imply email is authenticated.

---

## Do not promise these

- **US-3, the agent choosing its channel.** Nothing wakes itself on a schedule.
- **US-5, answering an outsider.** Inbound only. Attempting it produces a real
  error: *"this email bridge is inbound-only, so there is nowhere to send
  atlas's message"*.
- **Forwarding real mail.** The first genuine forward attempted — a newsletter —
  was lost outright (`M_TOO_LARGE`). It now arrives truncated with a notice, and
  a forward's attachments still never reach the agent. See **D5**. Demo email
  with short, purpose-written messages until that is fixed.
- **Enforced disclosure.** See Demo B.

---

## Two setup notes that will bite

Both cost a diagnosis during testing and neither logs anything useful.

**Slack mentions.** If the workspace has ever run Switch, register the bridge
with `agent_usergroups: true`. With it off, picking the agent from the `@` menu
sends `<!subteam^S…>`, nothing maps it back to the agent's name, and the message
is filed as unaddressed chatter — the agent simply never answers a mention that
looks perfectly normal. Note that `true` creates a user group for *every* agent
on the server and the bot **cannot** remove them afterwards, so delete dead
agents first.

**Session wake-up needs Switch Console.** A bare `claude` session with the
connector reads its rooms fine and is never woken: Switch Console's watcher is
what injects a room message into the running session. Without the app you get a
session that looks healthy and is deaf.
