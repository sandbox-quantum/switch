# Incident response on Switch

How an on-call/incident-response SOP runs on Switch: the room shape, a reusable
room template that provisions a war room, and a responder agent that a rotating
on-call group can share without any one engineer owning it.

This is a design, not an implementation. Nothing here has been built. Where
Switch cannot do what the SOP needs, the gap is named and a ticket proposed
rather than designed around — [Gaps](#gaps) is the part to read if you read
only one section.

Written against `main` at `514d5ba4` (the template registry). Every claim about
current behaviour was checked against the code, and the file it lives in is
cited so a reader can confirm it rather than trust it.

## Scope

The subject is a specific SOP: a lightweight, post-launch, business-hours
rotation that pages through PagerDuty and coordinates in Slack. It is
deliberately temporary — its own text says it will be replaced once a 24/7
rotation and real tooling exist. So the design optimises for *reuse and
disposal*, not for permanence: a template a team instantiates per incident and
throws away, not a standing structure to maintain.

The SOP belongs to one product team. This document does not reproduce it. The
team's channel names, service owners and escalation contacts are inputs, not
content — they arrive as template parameters at instantiation time. That keeps
this document reusable across products, and keeps a public repository free of
one team's internal routing.

**Out of scope.** Designing the PagerDuty or Datadog integrations themselves;
Switch Console's side of any of this; anything that needs code to exist before
it can be described. Where the SOP depends on such a thing, it appears in
[Gaps](#gaps).

## The SOP, and the one place Switch appears in it

The flow, compressed:

1. A Datadog monitor breaches and pages the on-call primary through PagerDuty,
   repeating up to three times. The same alerts also land in a standing alert
   channel.
2. On-call acknowledges in PagerDuty — "I'm investigating."
3. On-call triages against logs, dashboards and runbooks, and decides the one
   question that matters: **is a customer affected?** No means it is a routine
   alert, resolved in PagerDuty with notes, and nothing else happens. Yes means
   a customer incident is declared.
4. Declaring sets a severity, and **the declaration is what triggers
   coordination**. At the top severity a dedicated war-room channel is created
   and the responders are pulled into it.
5. Updates go out on a clock — hourly at the top severity, every four hours at
   the next — as a five-field situation report posted to both the alert channel
   and the stakeholder channel.
6. On-call acts on their own authority (roll back, roll forward, emergency fix)
   and escalates if it is not resolved in about an hour, up a four-tier ladder.
7. Recovery is confirmed in PagerDuty, a postmortem is written, and a review is
   scheduled within five business days for the top severity.

Read that list again and notice how little of it is Switch's. Paging, ack,
severity, the resolve, the audit trail of the incident record — all PagerDuty.
Diagnosis is Datadog and the runbooks. Switch appears at exactly one point, step
4:

> Switch will auto-create a dedicated Slack channel and invite on-call engineers
> to the war room.

That is the whole ask, and it is worth being blunt about the size of it: **the
SOP does not need Switch to run incident response. It needs Switch to
manufacture a correctly-shaped, correctly-populated room in the seconds after a
declaration, and then to be useful inside it.** A design that tries to move
severity, paging or the incident record into Switch is designing a competitor to
PagerDuty that nobody asked for.

The value Switch adds is not the channel — Slack can make a channel. It is that
the room arrives *already furnished*: the runbook attached, the service-owner
map attached, the situation-report shape attached, the responder agent already
in it and already briefed on which service is broken and how severe it is. A
human doing this by hand at 03:00 does it badly or not at all.

### The questions the SOP has not answered

The source document carries open comments, and three of them are load-bearing
for this design. They are not oversights in the SOP; they are places where the
SOP is waiting on Switch:

- **"How will Switch pull in who's on-call from PagerDuty?"** Nobody has
  answered this. It is the single hardest requirement in the document, and
  [Gaps](#gaps) treats it as such.
- **"Can we automate mirroring updates from the alert channel into the
  stakeholder channel?"** Two rooms, one message, no relay.
- **"A scheduled Slack workflow could mention the Switch agent to kick off
  updates."** This one is already the right answer, and it works today —
  see [Cadence](#cadence-and-the-thing-that-nudges).

A fourth comment observes that postmortems are missing from the SOP entirely.
The template can help there, and does.

## Mapping the SOP onto rooms

Switch has exactly one structural primitive that matters here — the room — plus
threads inside it and links between rooms. Getting the mapping right is mostly a
matter of refusing to over-model.

### What is a room

**Three, and only three.**

**The alert hub** — standing, long-lived, one per product. Datadog's alerts land
here, and this is where on-call acknowledges and posts situation reports. It
already exists as a Slack channel; adopting it into Switch is a matter of adding
the Switch app to it, not creating anything. High volume, low signal, and nobody
should be expected to have read it.

**The stakeholder channel** — standing, long-lived, one per product. High-level
status only, for people who need to know that something is wrong and not how.
Also already exists.

**The war room** — one per declared incident, created at declaration, dead after
the postmortem. This is the room the template makes. Public, per the SOP's own
resolution of that question: a war room that stakeholders cannot read generates
a second, worse war room in DMs.

The two standing rooms are not the template's business. They are pre-existing
channels the template *points at*, and their names are parameters.

### What is a thread

Everything that would otherwise fragment the war room. In particular:

- **A workstream inside the incident.** Two people chasing two hypotheses thread
  separately and the room stays readable.
- **A situation report and its follow-ups.** The SITREP goes at the root; the
  "what does that mean for the API?" questions hang off it.
- **A tool's noisy output.** Log dumps and query results belong under the
  message that asked for them.

Switch threads bridge natively to Mattermost and to Telegram forum topics. On a
Slack-bridged room — which this is — a threaded reply shows in the channel as a
reply count under the original post, so **anything the room must not miss goes at
the root**. That is not a Switch limitation to work around; it is a rule for
whoever writes in the room, agent or human. The responder agent's standing
instructions should say so, and the template's `instructions` field is where
that lives.

### What is neither

Three things that look like they want to be rooms and must not be.

**The incident itself.** The incident is a PagerDuty record with an id, a
severity, a timeline and a resolution. The war room is a *conversation about* it.
Modelling the incident in Switch means two systems disagreeing about severity at
the worst possible moment. The room carries the incident id in its name and a
link to the record in its description; that is the whole of the relationship.

**The on-call rotation.** A rotation is a schedule — who is responsible between
which hours. Switch has no schedule, no rotation and no concept of duty (see
[Gaps](#gaps)). A "rotation room" would be a room whose membership someone has to
remember to edit every Monday, which is a worse rotation than the one PagerDuty
already runs. The rotation stays in PagerDuty and reaches Switch, if at all, as a
mention group.

**A per-service standing room.** Tempting, because the SOP's severity table is
organised by service and each service has an owner. But a room per service is a
room per service to keep alive, and the thing that is actually needed — "who owns
the ingestion pipeline, and what does its runbook say" — is a lookup, not a
conversation. It belongs in the war room as an attached document, which is
exactly what the template does with it.

### The lifecycle, end to end

| Moment | What happens in Switch |
| --- | --- |
| Alert fires | Nothing. Datadog → PagerDuty → the alert hub channel. |
| Ack, triage | Nothing. On-call works in PagerDuty, Datadog and the runbooks. |
| Routine alert, no customer impact | Nothing, ever. Most alerts end here and must cost zero Switch overhead. |
| **Customer incident declared** | **The war room is instantiated from the template**, named for the incident, furnished with runbook, owner map and SITREP shape, with the responder agent already in it and briefed. |
| Responders assemble | Invitees are added: on-call, the service owner, the stream lead, support. Public channel, so anyone else can walk in. |
| Investigation | Threads per hypothesis. The responder agent answers lookups, drafts SITREPs, and keeps the timeline. |
| Situation report due | A scheduled nudge addresses the responder agent; it drafts from the room and a human posts or corrects it. |
| Escalation at ~1h | A human decision. Switch's part is that the escalation ladder is *in the room* as a document, so nobody has to find it. |
| Recovery confirmed | The room stays open — the postmortem is written from it. |
| Postmortem written | The seeded postmortem document is filled in from the room's own timeline. |
| Review scheduled and held | Out of Switch. |
| Done | The room is archived. Archive is not deletion; the transcript survives. |

Two properties of that table are the design:

- **Nothing happens until a customer incident is declared.** The overwhelmingly
  common path — an alert that resolves itself — never touches Switch. Any design
  that provisions a room per alert will be switched off within a week.
- **The room outlives the incident.** It closes at the postmortem, not at
  recovery. The postmortem is written from the room's own record, which is the
  main argument for having conducted the incident in a room at all.

### Cadence, and the thing that nudges

The SOP puts situation reports on a clock: hourly at the top severity, every four
hours below it. Something has to remember.

**Switch cannot.** There is no scheduler, no cron, no timer, and no deferred
action anywhere in `core/switch_core` — the only `schedule` symbols in the tree
are `asyncio` call-soon helpers inside the transport and bridge loops. An agent
in a room cannot ask to be woken in an hour.

The SOP's own comment thread already has the answer, and it is the right one: a
scheduled Slack workflow that posts into the war room mentioning the responder
agent. The mention arrives as an addressed event, the agent drafts the SITREP
from the room's context, a human checks and posts it. This works today, needs no
Switch change, and keeps the clock in the tool that is good at clocks.

It is worth being honest that this is a workaround, not a design: the schedule
lives in a Slack workflow that nobody will remember to delete when the incident
closes, and it has to be created per incident. That is a real cost, and it is
[Gaps](#gaps) item G7.
