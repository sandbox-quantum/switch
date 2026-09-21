# Incident response on Switch

How an on-call/incident-response SOP runs on Switch: a standing incident hub, a
shared responder agent that builds a war room per incident, and PagerDuty reached
the same way Jira already is.

This is a design, not an implementation. Nothing here has been built. Where
Switch cannot do what the SOP needs, the gap is named and a ticket proposed
rather than designed around — [Gaps](#gaps) is the part to read if you read only
one section.

Written against `main` at `514d5ba4` (the template registry). Every claim about
how Switch behaves today was checked against the code on that commit rather than
recalled, and where a behaviour is surprising enough to be worth confirming, the
file it lives in is named. If a claim here has since gone stale, the commit is
the thing to diff against.

**The instruction text this design needs is in a companion document** —
[`incident-response-instructions.md`](incident-response-instructions.md). Every
block, labelled with the field it goes in: the agent's procedure and output
contract, the hub and war-room instructions, both roles, the four documents and
the references. This document is the argument; that one is the configuration.

- [Scope](#scope)
- [The SOP, and the one place Switch appears in it](#the-sop-and-the-one-place-switch-appears-in-it)
- [Mapping the SOP onto rooms](#mapping-the-sop-onto-rooms)
- [The incident-response agent](#the-incident-response-agent)
- [Reaching PagerDuty](#reaching-pagerduty)
- [Where the agent runs](#where-the-agent-runs)
- [Making the agent user-agnostic](#making-the-agent-user-agnostic)
- [Gaps](#gaps)
- [What to build first](#what-to-build-first)

## Scope

The subject is a specific SOP: a lightweight, post-launch, business-hours
rotation that pages through PagerDuty and coordinates in Slack. It is
deliberately temporary — its own text says it will be replaced once a 24/7
rotation and real tooling exist. So the design optimises for *reuse and
disposal*: a shape a team can stand up per product and throw away, not a standing
structure to maintain.

The SOP belongs to one product team. This document does not reproduce it. The
team's channel names, service owners and escalation contacts are configuration,
not content — they live in one bindings block, supplied per product. That keeps
this design reusable across products, and keeps a public repository free of one
team's internal routing.

**Out of scope.** Designing the PagerDuty or Datadog products' own
configuration; Switch Console's side of any of this; anything that needs code to
exist before it can be described. Where the SOP depends on such a thing, it
appears in [Gaps](#gaps).

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
   the next, **until the issue is mitigated** — as a five-field situation report
   posted to both the alert channel and the stakeholder channel. The SOP sets no
   cadence for the lowest severity.
6. On-call acts on their own authority (roll back, roll forward, emergency fix)
   and escalates if it is not resolved in about an hour, up a four-tier ladder.
7. Recovery is confirmed in PagerDuty, a postmortem is written, and a review is
   scheduled within five business days for the top severity.

Read that list again and notice how little of it is Switch's. Paging, ack,
severity, the resolve, the incident record — all PagerDuty. Diagnosis is Datadog
and the runbooks. Switch appears at exactly one point, step 4:

> Switch will auto-create a dedicated Slack channel and invite on-call engineers
> to the war room.

That is the whole ask, and it is worth being blunt about the size of it: **the
SOP does not need Switch to run incident response. It needs Switch to
manufacture a correctly-shaped, correctly-populated room in the seconds after a
declaration, and then to be useful inside it.** A design that moves severity,
paging or the incident record into Switch is building a competitor to PagerDuty
that nobody asked for.

The value Switch adds is not the channel — Slack can make a channel. It is that
the room arrives *already furnished*: the runbook attached, the service-owner map
attached, the situation-report shape attached, the right people already invited
because something looked up who was on call, and a responder agent already in the
room and already briefed on which service is broken and how severe it is. A human
doing this by hand at 03:00 does it badly or not at all.

### The questions the SOP has not answered

The source document carries open comments, and three are load-bearing. They are
not oversights in the SOP; they are places where it is waiting on Switch:

- **"How will Switch pull in who's on-call from PagerDuty?"** This turns out to
  have a clean answer, and it is not the one anybody expected — see
  [Reaching PagerDuty](#reaching-pagerduty).
- **"Can we automate mirroring updates from the alert channel into the
  stakeholder channel?"** Two rooms, one message, no relay. [Gaps](#gaps) G8.
- **"A scheduled Slack workflow could mention the Switch agent to kick off
  updates."** Already the right answer, and it works today — see
  [Cadence](#cadence-and-the-thing-that-nudges).

A fourth comment observes that postmortems are missing from the SOP entirely.
The design gives them a home.

## Mapping the SOP onto rooms

Switch has one structural primitive that matters here — the room — plus threads
inside it and links between rooms. Getting the mapping right is mostly a matter
of refusing to over-model.

### What is a room

**Three, and only three.**

**The incident hub** — standing, long-lived, one per product. This is the
existing alert channel, adopted into Switch rather than created: Datadog's alerts
land here, on-call acknowledges here, situation reports are posted here, and the
responder agent lives here permanently. It is also where an incident is
*declared*. Its `instructions` carry the SOP and the product's bindings, which is
what makes one design work for several products.

**The stakeholder channel** — standing, long-lived, one per product. High-level
status only, for people who need to know that something is wrong and not how.
Already exists; adopted, not created.

**The war room** — one per declared incident, built by the responder agent at
declaration, dead after the postmortem. Public, per the SOP's own resolution of
that question: a war room stakeholders cannot read generates a second, worse war
room in DMs.

**One room per incident, and the postmortem happens in it.** This was a live
question — a second, linked postmortem room is defensible, and it is what a
group template would naturally produce — and the answer is no. The postmortem's
raw material is the war room's own timeline, so moving the write-up to a second
room separates the evidence from the analysis at exactly the moment you want
them together, and asks people to follow a link days after they stopped caring.
The war room simply stays open until the write-up is done, with the postmortem
skeleton already attached as a document from the moment it was created. This is
also the cheaper design: it needs no group template, no room links between the
two, and nothing to keep them in step.

### What is a thread

Everything that would otherwise fragment a room. In the war room: one thread per
line of investigation, one per situation report and its follow-ups, one for a
tool's noisy output. In the hub: **one thread per incident**, which is the whole
of the banner protocol below.

Switch threads bridge to real platform threads everywhere it can — Slack replies
go out with a `thread_ts`, Discord gets a real thread, Telegram gets a forum
topic. The Slack difference is one of *rendering*: a threaded reply appears in
the channel only as a reply count under the original post rather than in the main
flow. So on a Slack-bridged room — which both of these are — **anything the room
must not miss goes at the root**. That is a rule for whoever writes in the room,
agent or human, and it belongs in the room's instructions.

### What is neither

**The incident itself.** The incident is a PagerDuty record with an id, a
severity, a timeline and a resolution. The war room is a *conversation about* it.
Modelling the incident in Switch means two systems disagreeing about severity at
the worst possible moment. The room carries the incident id in its name and a
link to the record in its description; that is the whole relationship.

**The on-call rotation.** A rotation is a schedule. Switch has no schedule and no
concept of duty, and — importantly — it does not need one, because the agent can
ask PagerDuty. A "rotation room" would be a room whose membership someone has to
remember to edit every Monday, which is a worse rotation than the one PagerDuty
already runs.

**A per-service standing room.** Tempting, because the SOP's severity table is
organised by service and each service has an owner. But the thing actually needed
— "who owns the ingestion pipeline, and what does its runbook say" — is a lookup,
not a conversation. It belongs in the war room as an attached document.

### The lifecycle, end to end

| Moment | What happens in Switch |
| --- | --- |
| Alert fires | Nothing. Datadog → PagerDuty → the hub channel, as context. |
| Ack, triage | Nothing. On-call works in PagerDuty, Datadog and the runbooks. |
| Routine alert, no customer impact | Nothing, ever. Most alerts end here and must cost zero Switch overhead. |
| **Customer incident declared** | On-call addresses the responder agent in the hub. The agent looks up who is on call, **builds the war room**, and posts the incident banner in the hub. |
| Responders assemble | Already done — the agent invited them when it built the room. Public channel, so anyone else can walk in. |
| Investigation | Threads per hypothesis. The agent answers lookups, drafts SITREPs, keeps the timeline. |
| Situation report due | The agent's poll notices the posted deadline has passed; it drafts from the room and a human sends it. The SITREP goes in the hub, under the incident's banner thread. |
| **Mitigated** | A human says so. The update clock stops — this is the stopping condition, not recovery or resolution. The room stays open. |
| Escalation at ~1h | A human decision. Switch's part is that the ladder is *in the room* as a document, so nobody has to find it. |
| Recovery confirmed | The room stays open — the postmortem is written from it. |
| Postmortem written | Drafted from the room's own timeline into the seeded postmortem document. |
| Done | The agent archives the war room. Archive is not deletion; the transcript survives. |

Two properties of that table are the design:

- **Nothing happens until a customer incident is declared.** The overwhelmingly
  common path — an alert that resolves itself — never touches Switch. A design
  that provisions a room per alert gets switched off within a week.
- **The room outlives the incident.** It closes at the postmortem, not at
  recovery. That is the main argument for having conducted the incident in a
  room at all.

### Cadence, and the thing that nudges

The SOP puts situation reports on a clock: hourly at sev0, every four hours at
sev1, in both cases **until the issue is mitigated** — not until it is resolved,
and not until the postmortem is written. It sets no cadence at sev2 at all.
Something has to remember all three of those facts, including the stopping
condition, which is the one an automated clock is most likely to miss.

**Switch cannot.** There is no scheduling primitive exposed to a room: no cron,
no timers, nothing that wakes an agent on a clock. Switch runs periodic work
internally — connection and runtime-state sweeps, bridge renewal loops, timers
that batch attachments — but none of it is reachable from a room.

The agent's *host* can keep time — Claude Code has cron — and the shape of how
you use it matters more than whether you use it.

A timer set to the SOP's interval is the obvious thing and the wrong one. It
fires only while the session is **idle**, so an hourly job slips precisely when
an incident is busy. Recurring jobs carry jitter, so it drifts. And it fires into
a *session*, not a room, which with two incidents running looks like a routing
problem.

A timer used as a **poll** dissolves all three. Fire every ten minutes; each time,
compare what the agent posted against the clock and act only if something is due.
Slip costs minutes instead of an interval, jitter stops mattering because the
timer is no longer the deadline, and a severity change mid-incident is picked up
because the interval is re-read each pass instead of baked into a cron
expression. The routing problem is not a problem either: the prompt tells the
agent to service whatever needs servicing, and it derives the list from its own
non-archived war rooms — so one standing job covers every concurrent incident and
nothing needs rewiring when a second one opens. It can check the others without
moving, since a room's context can be read by id, and only connect to the one it
must post in.

So the clock is kept in three layers:

1. **A deadline posted in the room** — `next update due HH:MM`, kept current by
   the agent. It survives a dead session, a missed poll and a broken workflow,
   and it is enforced by the people who can see it. **It is the deadline**; the
   timer's only job is to make the agent look at it.
2. **The agent's own standing timer**, as the working mechanism: one durable
   poll, created when the first war room opens and deleted when the last is
   archived.
3. **An external check, as a dead-man's switch** — low-frequency, not per
   incident. Its job is not to carry the cadence but to notice if the agent is
   gone, because a timer lives in the session and **shares a failure mode with
   the agent it is supposed to prompt**. A host restart (G22) or a crashed
   session takes the clock with the responder, silently, at the moment somebody
   most needs to know. That is the one thing the agent cannot check for itself.

This is a better arrangement than it first looks: the per-incident scheduled
workflow that earlier drafts leaned on — created by hand each time, deleted by
nobody — is gone entirely, replaced by one standing poll the agent owns and one
heartbeat that does not care how many incidents are running.

Two rules that fall out and belong in the agent's instructions: the interval runs
from the last update **sent**, not from the top of the hour, so a late update
does not compress the next window; and a draft that was posted and never sent
must be called out, because from outside the room it is indistinguishable from an
update nobody wrote.

What remains missing is a schedule the *room* owns — visible, cancellable by
anyone, disposed of with the room. [Gaps](#gaps) G7.

## The incident-response agent

The room is built by an agent, not instantiated from a room template. That is the
central decision in this document, and it is worth setting out why before the
detail.

### The prior art: the workstream hub

Switch already runs a production pattern with exactly this shape — the workstream
hubs that drive this repository's own development. Read from the inside, it is:

- **A standing hub room**, bridged to a channel, whose `instructions` are a
  complete operating manual: the workstream's scope, how work is requested, and
  a **bindings block** of instance data — the Jira cloudId, project key, label,
  transition ids and assignee account ids; the bridge id and channel type to
  create work rooms on; the room-group name; the shared reference id to
  propagate into every work room.
- **An exclusive room role**, described in its own instructions as a *thin
  shell*. It grants two things and nothing else: the exclusive coordination lease
  (at most one live holder) and `@manager` addressing, "so anyone can reach
  whoever is currently coordinating without knowing which agent that is." The
  procedure is deliberately **not** in the role — it lives in the agent.
- **A manager agent** that assumes the role automatically on connecting, every
  session, silently.
- **One room per work item**, created by the agent — private, named to a
  convention, filed in a group, linked back to the hub, with the shared
  reference propagated and the room's `instructions` set to a full task card
  written for whoever picks it up.
- **A banner protocol**: exactly one root-level message per item in the hub, and
  its thread is that item's entire conversation — status changes and the final
  summary included.
- **A pure-pull model**, stated explicitly: nothing happens automatically; work
  proceeds when someone requests it and the manager is online. A hub with nobody
  holding the role is idle, not broken.

Every one of those transfers. An incident is a work item with a clock on it.

### The incident hub

One per product. The existing alert channel, adopted into Switch.

Its `instructions` carry three things:

1. **The SOP** — the declaration criteria, the severity table, the update
   cadence, the escalation ladder, and the authority the on-call already has.
2. **The room-writing rules** — root versus thread, and the standing note that
   severity and resolution live in PagerDuty, not here.
3. **The bindings block** — everything instance-specific, in one place, so the
   same agent definition serves every product:

```
## Responder bindings

**PagerDuty** (MCP)
- Service ids: <one per service in the severity table>
- Escalation policy id: <...>
- Severity map: sev0 → P0, sev1 → P1, sev2 → P2 (confirm against the
  priority scheme actually configured in PagerDuty)
- On-call lookup: the schedule attached to the escalation policy above

**Rooms / bridge**
- War rooms: new channel on the INTERNAL workspace bridge — bridge_id=<...>,
  channel_type="channel_public", named `<product> incident <id>`
- Room group: <product> incidents
- Every war room is linked back to this hub
- Runbook reference id to propagate: <...>
- Stakeholder channel for status: <...>

**People**
- Always invite: the on-call primary (from PagerDuty), the owning service's
  owner, the stream lead, support
- Escalation contacts by tier: <role names, not people>
```

**"Public" and "not external-facing" are two different axes, and only one of
them is `channel_type`.** A war room should be a public channel — readable by
anyone inside the company, per the SOP's own resolution, because a war room
stakeholders cannot read grows a second, worse war room in DMs. It should also
never be visible outside the company.

The second of those is the **bridge**, not the channel type. A deployment with
more than one workspace connected — an internal one and a partner or
customer-facing one — has a bridge id for each, and `create_room` will happily
provision on whichever it is given. Nothing in Switch knows that one of them
faces outward. So the internal bridge id is pinned in the bindings above, and
the agent's instructions should say to use that one and never to take a bridge
id from the request that declared the incident. Getting this wrong publishes an
outage to people outside the company, and it would be a plausible mistake at
03:00.

This is also why the bindings block exists at all. Everything that is specific
to the company — channel ids, service ids, owner names, which workspace is the
internal one — lives in one block of room configuration. The agent definition,
the room shape and this document stay generic and carry none of it.

And one **exclusive `responder` role**, the same thin shell: the lease plus
`@responder` addressing, so anyone in the channel reaches whoever is currently
coordinating without knowing which agent that is. The agent assumes it on
connect.

### What the agent does when an incident is declared

On-call posts in the hub:

> `@responder` declare sev0 on ingestion — no new findings for 40 minutes, PD 1287

The agent then, in order:

1. **Reads the bindings** from the hub's instructions.
2. **Asks PagerDuty who is on call** for the escalation policy, and reads the
   incident record for the id, title and current severity. If PagerDuty and the
   human disagree about severity, it says so in the room and takes PagerDuty's.
3. **Resolves the invitee list** — the on-call primary from PagerDuty, plus the
   service owner, stream lead and support from the bindings.
4. **Builds the war room** with a single `create_room` call (below).
5. **Posts the banner** in the hub — one root-level message, the incident's
   entire thread from here on.
6. **Greets the room** with what it already knows: severity, service, the
   incident link, and the fact that the runbook and owner map are attached.

Step 4 is the one that has to be an agent rather than a template, and step 2 is
the one that closes the SOP's hardest open question.

### The room it builds

Expressed as YAML, because a reviewable artifact beats prose and because the
parts of it that *are* expressible as a room template can be registered as one —
as documentation of the shape, and as a fallback when no agent is online.

```yaml
version: 0

params:
  # ── the incident ──────────────────────────────────────────────────────────
  incident_id:
    type: string
    description: Incident record id, e.g. 1287
  severity:
    type: enum
    enum: [sev0, sev1, sev2]
    description: Declared severity; sets the update cadence
  service:
    type: string
    description: The affected service, as named in the severity guidelines
  summary:
    type: string
    description: One line — what is broken, in a stakeholder's words
  incident_url:
    type: string
    description: Link to the incident record in the paging system

  # ── the product (from the hub's bindings) ─────────────────────────────────
  product:
    type: string
    description: Short product name; prefixes the room and channel name
  hub_channel:
    type: string
    description: The incident hub, where situation reports are posted
  comms_channel:
    type: string
    description: Channel where stakeholder updates go
  runbook_reference:
    type: string
    description: Name of the Switch reference holding this product's runbooks
  responder_agent:
    type: string
    description: The shared incident responder agent

  # ── the deployment ────────────────────────────────────────────────────────
  bridge:
    type: string
    description: Collaboration bridge display name
  visibility:
    type: enum
    enum: [channel_public, channel_private]
    default: channel_public
    description: War rooms are public by default, per the SOP

room:
  name: "{product} incident {incident_id}"
  description: "{severity} · {service} · {summary} · {incident_url}"
  bridge: "{bridge}"
  channel_type: "{visibility}"
  read_visibility: public
  write_visibility: private

  agents: ["{responder_agent}"]

  instructions: |
    This is the war room for {product} incident {incident_id} — {severity} on
    {service}.

    What is broken: {summary}
    The incident record is the system of record: {incident_url}

    ## For everyone in this room

    Post at the ROOT for anything the room must not miss. This room is bridged
    to Slack, where a threaded reply shows only as a reply count under the
    original post — a status change buried in a thread will be missed. Use
    threads for a single line of investigation, for follow-up questions under a
    situation report, and for tool output.

    Severity, ack and resolution live in the paging system, not here. If they
    disagree, the paging system is right. Update it there and say so here.

    ## For the responder agent

    You are here to remove lookups and paperwork from the responders, not to
    run the incident. A human decides what to do.

    - Answer from the attached documents first. The service-owner map says who
      owns {service}; the runbook reference points at how to diagnose it. Cite
      what you used.
    - When asked for a situation report, draft it in the shape the attached
      SITREP document gives and post the draft here. A human posts it onward to
      {hub_channel} and {comms_channel} — you do not post to those channels.
    - Keep a running timeline as the incident moves: what changed, when, who
      did it. The postmortem is written from it.
    - Say what you do not know. During an incident a confident wrong answer
      costs more than silence.
    - Cadence for {severity}: sev0 hourly, sev1 every four hours, in both cases
      until a human says the issue is mitigated. sev2 has no cadence. You keep
      the next deadline posted here; if it passes without an update, say so.

    ## Escalation

    Escalate if this is not resolved in about an hour. The ladder is in the
    attached escalation document. Escalating is not an admission of failure and
    does not need sign-off.

  roles:
    - name: scribe
      exclusive: true
      instructions: |
        You are keeping this incident's timeline. Record what changed, when,
        and who did it, as it happens — one line per event, at the room root.
        Do not editorialise and do not diagnose; the timeline is evidence for
        the postmortem, not an analysis.

        Read the room's history before you start, so the timeline begins at the
        declaration and not at the moment you arrived.

  references:
    - name: "{runbook_reference}"

  docs:
    - name: "Service owners"
      description: "Which service belongs to whom, and in which timezone"
      instructions: |
        Consult before asking the room who owns something. Answer from this and
        cite it. If {service} is not listed, say so plainly rather than
        guessing — an unlisted service is a real gap in the SOP, not a lookup
        failure.
      content: |
        # Service owners

        Filled in per product from the hub's bindings. One row per service:
        service, owning team, primary contact role, timezone.

        A service with no owner is an escalation to the incident coordinator,
        not a dead end.

    - name: "Situation report"
      description: "The five fields a situation report must carry"
      instructions: |
        Use this shape verbatim when drafting a situation report. Do not add
        fields, do not drop the Ask — an update with no Ask reads as "no help
        needed" and that is rarely true.
      content: |
        # Situation report

        - **Summary** — one line: what is broken, plus the incident id.
        - **Severity** — the declared severity, and impact: who and what, and
          the blast radius.
        - **Started** — time, and the suspected trigger (a deploy, a config
          change, unknown).
        - **Progress** — diagnostics run, actions tried, current state.
          (The source SOP calls this field "Progress" in one place and "Done"
          in another. Pick one and keep it; this design uses Progress.)
        - **Ask** — what help is needed, from whom. Say "none" explicitly if
          none.

    - name: "Escalation ladder"
      description: "Who to pull in, and when"
      instructions: |
        Consult when an incident has run about an hour without resolution, or
        when someone asks who to escalate to. Name the tier, not a person —
        the room will know who currently holds it.
      content: |
        # Escalation ladder

        1. **On-call primary** — every declared incident.
        2. **Workstream lead or service owner** — stuck about an hour, or the
           problem needs depth in one service. Have a situation report ready
           before escalating.
        3. **Engineering and product decision pair** — the fix needs a business
           call quickly.
        4. **Incident coordinator and leads** — org-wide impact, or all hands.

        Escalation is time-based, not judgement-based. An hour without
        resolution escalates whether or not it feels close.

    - name: "Postmortem"
      description: "The write-up this incident owes, and the shape of it"
      instructions: |
        Fill this in from the room's own timeline once recovery is confirmed.
        Draft it here; a human owns it. Blameless: name systems and decisions,
        never people.
      content: |
        # Postmortem — {product} incident {incident_id}

        - **What happened** — the customer-visible failure, in one paragraph.
        - **Impact** — who was affected, how many, for how long.
        - **Timeline** — from the first signal to recovery confirmed.
        - **Root cause** — the five whys, not the first why.
        - **What went well** — including anything that limited the blast radius.
        - **What did not** — detection gaps, missing runbooks, wrong owners.
        - **Actions** — each with an owner and a ticket. An action with neither
          is a wish.

        Review within five business days for the top severity.
```

That document is not illustrative. It was run through the shipped parser —
`ParamSpec`, `resolve_params`, `interpolate`, `RoomSpec`, and the visibility-pair
validator — and it resolves: `visibility` defaults to `channel_public`, the
`public` / `private` visibility pair is accepted, every placeholder substitutes
with none left over anywhere including inside the seeded documents, the room
comes out named `flint incident 1287`, and the Slack channel it would create is
`flint-incident-1287`. Anything wrong here is a bug in the design, not a typo.

Four choices in it that are not arbitrary:

- **`channel_type: "{visibility}"` is the whole-field form.** When a field is the
  *entire* placeholder, the parameter's typed value is substituted rather than
  stringified. For an `enum` the two coincide, but it is the only way a `number`
  or `boolean` parameter can fill a non-string field, and a partial placeholder
  degrades to a string silently.
- **The room name slugifies cleanly.** Switch derives the Slack channel name with
  `re.sub(r"[^a-z0-9_-]", "-", name.lower()).strip("-")[:80]`
  (`core/switch_core/bridges/collaboration/slack/adapter.py:1366`). The SOP's
  bracketed convention — `[Product] [Incident #]` — yields
  `product---incident-42`. `{product} incident {incident_id}` yields
  `product-incident-42`. Cosmetic, but channel names are what responders type
  under pressure.
- **`write_visibility: private`, and this is the one to argue about.** Public
  write on a room does not mean "participants may restructure it" — it grants
  write to *any* principal in the tenant, member or not, and write on a room is
  what governs attaching a reference, defining and deleting roles, updating the
  room and archiving it. A war room any agent's owner in the deployment can
  archive mid-incident is not a trade worth making. Adding agents and users is
  governed separately and admits existing members regardless, so pulling another
  agent in still works for anyone already in the room.
- **The `scribe` role is defined and assigned to nobody.** See
  [Roles, correctly scoped](#roles-correctly-scoped).

### What only the agent can do

The YAML above is the room's *shape*. Four things the agent adds that a room
template provisioned from that document cannot, because the template format does
not carry the fields — even though `create_room` accepts every one of them:

| The agent sets | A template cannot | Why it matters |
| --- | --- | --- |
| `aliases` | ✗ | `@responder` in the war room, so responders address a function, not an agent's name. |
| `linked_rooms` | ✗ | The war room points back at the hub, and the hub at it. |
| `group_name` | ✗ | Incidents filed under one product group instead of loose rooms sharing a prefix. |
| `join_event_listeners` | ✗ | Without it the agent never learns someone joined, so it cannot greet the fourth person arriving twenty minutes in and tell them the state. |
| `user_names` **computed at declaration** | ✗ | The template would need the invitee list as input; the agent *derives* it by asking PagerDuty. |

The last row is the real argument. A template is a function of its inputs, and
somebody has to supply them. An agent can go and find them. "Who is on call right
now" is not something a human should be typing into a form at 03:00, and it is
the exact question the SOP has an open comment about.

The first four are a cheaper argument but a sharper one: **a room template is
strictly less capable than the room creation it wraps.** Those fields already
exist on the config object and are already validated; the template format simply
does not pass them through. That makes [Gaps](#gaps) G9 a pass-through fix rather
than a feature — worth doing, and not worth waiting for.

### The banner protocol

One root-level message per incident in the hub, posted by the agent immediately
after the war room exists. Its thread is the incident's entire record in the hub:
every situation report, every severity change, the resolution, and a link to the
postmortem.

This is lifted unchanged from the workstream hubs, and it earns its place three
times over:

- The SOP already requires situation reports in the alert channel. Under the
  banner they are threaded under the incident they belong to instead of
  interleaved with unrelated alerts.
- Someone scrolling the hub sees one line per incident, not forty.
- The postmortem is written from one thread.

### Why an agent and not a room template

Stated plainly, because it is the decision everything else follows from:

- **A template cannot look anything up.** Every value must be supplied by whoever
  instantiates it. The single most valuable thing here — who is on call — is a
  lookup.
- **A template is less capable than `create_room`.** Aliases, links, group and
  join listeners are unreachable from the format today.
- **Nothing instantiates a stored template anyway.** The registry stores
  documents; `POST /rooms/from-yaml` provisions from a document in the request
  body; nothing joins them. And the dashboard's create-from-YAML page posts raw
  YAML with no `inputs`, so from the UI only a template whose every parameter has
  a default works at all — which an incident template, by definition, is not.
- **The room is only half the job.** Somebody has to post the banner, greet
  arrivals, draft the SITREP and archive the room at the end. That is an agent
  with a procedure, and once it exists, having it also make the room costs
  nothing.

The template is not useless — register the YAML above so the shape is reviewable,
diffable and available when no agent is online. But it is documentation of the
design, not the mechanism.

### What is actually reusable

Not a room template. Three things, together — which is what an **agent template**
would have to mean if the concept is going to earn its name:

1. **The agent definition** — the responder's procedure, identical for every
   product: read the bindings, look up on call, build the room, post the banner,
   draft SITREPs, keep the timeline, archive at the end.
2. **The hub room's instruction card** — the SOP text plus the bindings block,
   with the product-specific values filled in. This is the only thing that
   changes per product.
3. **The room shape** — the YAML above, as the specification the agent builds to.

Standing up incident response for a second product means writing one bindings
block. That is the reuse the ticket asked for, and it is a stronger form of it
than a room template can offer, because the varying part is one block of
configuration rather than a fork of the artifact.

## Reaching PagerDuty

The question was whether an agent can use an API or MCP for PagerDuty, "kinda
like what we do with Jira". The answer is yes — and it is worth being precise
about what the Jira pattern actually is, because it is not an integration.

### What the Jira pattern actually is

Switch's entire Jira presence is a **reference type**
(`core/switch_core/bridges/resource/registry.py:83-100`) whose agent-facing
instructions say:

> To access this Jira resource you need (1) access to the linked project,
> issue(s), or board, and (2) an agent connector that can fetch Jira content on
> your behalf — typically the Atlassian MCP connector…

Read what that is doing. Switch ships **the pointer and the prose**. It ships no
connector. The capability comes from an MCP server a human installed on the host
the agent runs on, and the instance specifics — cloudId, project key, transition
ids, account ids — live in the hub room's bindings block. Three parts, and only
one of them is Switch's.

That is the pattern to copy, and copying it is mostly configuration:

1. **A PagerDuty MCP server on the responder's host** (or, equivalently, a token
   in the host environment and the REST API through the agent's own shell). This
   is where the capability comes from.
2. **A `pagerduty` reference type**, user-defined — the type registry is open,
   any slug matching `^[a-z][a-z0-9_]{1,62}$` that is not a built-in — with
   instructions saying what the agent may do with it and what it must never do
   (change severity, resolve, acknowledge on someone's behalf). Attach the
   references to the hub and to each war room, or bundle them with the runbook
   in a package so it is one attach.
3. **A PagerDuty bindings block** in the hub's instructions: service ids,
   escalation policy id, the severity map, and which schedule to read for on
   call.

Be clear about the limits of step 2, because the Jira precedent has the same
ones: a reference type gives an agent a display name, a paragraph of
instructions, a value hint and a list of URLs. Every reference type — built-in or
custom — has the same value shape. **No credential, no client, no tool, no
network call.** If nobody installs the MCP server, the agent reads a paragraph
telling it to do something it cannot do.

### What this closes

The SOP's hardest open question — how Switch learns who is on call — stops being
a Switch question. The agent asks PagerDuty for the on-call for the escalation
policy, gets names, and passes them to `create_room(user_names=[...])`. Switch
never models a rotation, never syncs a schedule, and never goes stale.

This is a much better outcome than the alternative that suggested itself first
(teach Switch to expand a Slack user group into members). That would have been a
real feature with real maintenance, and it would still have been a second copy of
a rotation PagerDuty already owns.

Two residual constraints, neither fatal:

- The people it names must already be known to the bridge — `add_users_to_room`
  resolves usernames against the external users Switch has seen on that bridge,
  and an unknown name comes back unresolved rather than failing loudly. The
  agent should report unresolved names in the room rather than quietly
  inviting four of five people.
- PagerDuty's names are not Slack's. The bindings block needs a mapping, or the
  deployment needs PagerDuty users' Slack handles populated on their profiles.

### The two real constraints on MCP

**MCP is per-machine, not per-agent.** Every connector plugin bundles exactly one
MCP server — the Switch runtime — and every provider declares MCP scope as
`global`; the capability schema does not admit any other value. Switch Console
writes a per-agent *launch profile* (model, reasoning effort, instructions) and
deliberately registers no MCP server in it. The MCP management UI was removed and
the config adapters that remain have no live callers.

So giving the responder a PagerDuty MCP server means editing the host's global
config, and every agent session on that machine gets it. That is an argument for
the dedicated responder host this design already wanted — not against the
approach. [Gaps](#gaps) G19.

**There is no agent-scoped secret storage.** Switch encrypts its own API keys and
bridge tokens, and stores a server-side connector's config as plain JSONB. There
is nothing for a third-party credential belonging to one agent. A PagerDuty token
lives in the host's environment, or in Switch Console's per-provider environment
map — which is plaintext and applies to every agent of that provider. Switch
neither scopes it, rotates it, nor audits its use. [Gaps](#gaps) G20.

### The alternative: a server-side connector

Worth naming because it is the only Switch-managed, server-held,
credential-carrying integration point that exists. A server-side connector runs
in Switch's own process, discovers agents on an external platform, registers them
as Switch agents — deliberately **not** owner-only, with the comment that such an
agent "is a service the deployment offers everyone, not one person's assistant" —
and keeps them permanently online. One type exists today.

A PagerDuty connector would bend the shape: PagerDuty has no agents, so it would
discover one synthetic agent whose job is to answer PagerDuty questions in a
room. The cost is roughly one module implementing five methods plus a
registration line. The result is a *conversational* PagerDuty agent the responder
talks to, not a *tool* the responder calls — which is worse for this use case,
and it would put the PagerDuty token in cleartext in Postgres.

Recommend against it here. It is the right shape for a future where PagerDuty
access should be a deployment-wide service rather than one host's configuration,
and it is worth remembering then.

### The push direction, and why not to rely on it

Everything above is *pull*: the agent, while running, calls out to PagerDuty.
The other direction — PagerDuty causing something to happen in Switch — is
weaker, and the details matter because the failure is silent.

**What works.** A third-party app posting into a bridged Slack channel is not
filtered out. `bot_message` is explicitly on the adapter's allow-list, with a
comment naming Datadog alerts, and only the Switch app's *own* messages are
suppressed as echoes. The app gets a puppet identity named after it, and if its
message contains `@responder` — as literal text, or as the agent's Slack
user-group pill, which is what Workflow Builder inserts when you pick an agent
from the `@` menu — the agent is addressed, and an `auto_session` agent is
spawned to handle it.

**What does not.**

- **An alert with no mention wakes nothing.** Only *addressed* events are
  notifiable, and only a notifiable event spawns a session. The alert lands in
  the room as context and the responder never moves. This is the likely
  surprise.
- **Most of PagerDuty's message content is dropped.** Rich blocks are read only
  when the message has no plain-text body, and even then only `section`,
  `header` and `rich_text` blocks — `context` and `actions` blocks, where
  PagerDuty puts service, urgency, assignee and its buttons, are discarded.
  Attachments are read only if no block yielded anything. Since PagerDuty
  normally sets a text fallback for the notification preview, Switch usually
  sees that one line and nothing else.
- **Edits never arrive.** `message_changed` and `message_deleted` are dropped, so
  a PagerDuty message edited in place to "Resolved" leaves Switch's copy saying
  the incident is open.
- **An owner-scoped addressing policy turns this into noise.** A bot has no
  Switch account, so under a restricted policy every app-triggered mention is
  refused with a message telling PagerDuty to link its account in Switch
  Console — posted into the channel. One more reason the responder's policy must
  be open.
- **`!commands` from a workflow never wake a dormant agent**, though they work
  against a live session. Native slash commands are human-only.

**So the declaration is a mention, and the safest mention is a human's.** A human
addresses the responder in the hub. This matches the pull model the workstream
hubs adopted deliberately — "nothing happens automatically; work proceeds when
someone requests it" — it needs no Slack plumbing, and the SOP already has a
human in exactly that spot making exactly that decision.

An app-posted mention works too, and is the right answer for the cadence nudge,
where only the mention matters and the content does not. It is a weaker
foundation for declaration, where the content is the whole point and most of it
is what gets dropped.

### Why not a PagerDuty MCP channel

The obvious-looking alternative is to have a PagerDuty MCP server *push* into the
agent's session, the way the Switch runtime pushes room events. It is worth
walking through, because it is real, and because it is the wrong call.

**The mechanism exists.** Claude Code has a feature called **channels**: an MCP
server declares `experimental: {"claude/channel": {}}` and emits
`notifications/claude/channel`, and the host renders it into the session's
context as a `channel` block — starting a turn if the session is idle. This is
not part of the base MCP protocol; ordinary MCP tools are strictly pull, and the
standard server→client notifications (`list_changed`, logging) only refresh a
cache. Switch's own runtime is built on the channel, so the pattern is proven in
this codebase.

**Four gates stand between that and a working PagerDuty push.**

1. **It must ship as a marketplace plugin.** The enabling flag takes
   `plugin:<name>@<marketplace>`, not a bare server name, so a plain `.mcp.json`
   entry can never be named.
2. **The flag must be on argv at launch** — `--dangerously-load-development-channels`.
   Not settings, not config. Whatever starts the session has to pass it.
3. **The install must authenticate through Anthropic.** On Vertex, Bedrock or any
   third-party provider the flag is **ignored silently** — no error, no warning,
   no events.
4. **It is a research preview**, and the flag name is itself a stability
   statement. The protocol contract may change.

Gate 3 should decide it. Switch already carries this hazard for its own channel,
and the internals documentation is blunt about the consequence: registering an
agent as addressable when its host cannot receive notifications "leaves the room
expecting answers it will never send. **Nothing detects this.**" An on-call agent
that looks online and is not is the worst failure mode in this document.

**And the behavioural evidence is stronger than the documentary evidence.**
Switch built the channel, ships it, and documents it — and then disables it for
every session Switch Console manages, passes the flag nowhere in the app, and
reaches for keystroke injection into the TUI instead. Codex and OpenCode have no
channel at all; for them Switch Console or its sidecar is mandatory for any live
delivery. The configuration almost everyone actually runs does not use this
mechanism.

**The cheaper route gets the same outcome.** There is already a push path, it is
already load-bearing, and it needs nothing built: the responder's watcher holds
an event stream filtered to *addressed* events and spawns a session when one
arrives. So the job is not "build a push channel" — it is "make a PagerDuty
incident arrive as an addressed message in a room", which the Slack path above
already does. Same mechanism local or remote, every auth provider, and it reuses
the in-flight and already-attending guards that exist.

## Where the agent runs

The responder must be online when nobody's laptop is. Switch has a first-class
answer, and it is the same one the existing always-on agents use.

### The remote host and its sidecar

A **remote agent** is the same agent with its process on an SSH host. Nothing in
Switch core distinguishes it — same registration, same connection model, same
heartbeat. The difference is entirely in where the process runs and what
supervises it:

- Switch Console onboards a host by SSH alias and stores no credentials of its
  own, using the operator's existing SSH agent and config.
- Setting a host up runs an ordered **plan** — core tools (git, Node, tmux), then
  per agent type its CLI and the Switch connector. Nothing advances the plan on
  its own; each step runs when asked, and a check that could not run is not a
  passing check.
- The agent runs inside `tmux`, beside a **sidecar** the app deploys: a headless
  re-implementation of the session logic that starts sessions, keeps them
  connected to their rooms, and injects messages into their pane, with no app
  running anywhere.
- The sidecar — not the desktop app — holds the notification stream for a remote
  agent, filtered to addressed events, and spawns a session per room.

That sidecar is the push receiver this design needs, and it already exists. It is
why a remote host is the right call for the responder, and it is worth saying
plainly that this is a *hosting* decision rather than an architectural one: the
agent, the hub, the role and the room-building are identical either way.

Two consequences specific to running unattended, both of which matter more for an
incident responder than for anything else Switch hosts:

**Permission bypass defaults on.** A remote agent is onboarded with permission
bypass enabled, deliberately — it "runs unattended on the VM with no operator",
so a prompt nobody can answer is a hang. For a responder with shell access during
an incident, that is a decision to take explicitly rather than inherit. It is
also the strongest argument for
[the rule that makes it safe](#the-rule-that-makes-it-safe): if the agent is
never going to be stopped by a permission prompt, its restraint has to come from
its instructions and from the narrowness of what it is asked to do.

**A reboot ends it, and nothing brings it back.** Nothing registers a service;
after a host restart someone has to start things again by hand. For an agent
whose entire purpose is to be there at 03:00, that is a real availability gap,
and it is the one operational item on this list that could embarrass the SOP on
its first weekend. [Gaps](#gaps) G22.

### Whose host is it?

A shared responder should not run on an engineer's personal VM. That is not
fastidiousness — the agent is the team's, so every substrate under it should be
too, and a personal box makes the team's on-call coverage depend on one person's
machine, cloud account and availability. Switch's own documentation names the
failure: a host that depends on one person "is fine if you're the only one who
relies on that agent. It's a blocker when a teammate in another time zone needs
it while you're asleep."

**Switch has no concept of a team-owned host.** A remote host is a record in
Switch Console's *own local database* — an `~/.ssh/config` alias, a display name,
and nothing else. No user column, no tenant, no server-side row: Switch core has
never heard of hosts. Two engineers onboarding the same machine create two
unrelated records in two separate local databases, with nothing linking them.
Host sharing is not modelled; it is *defended against*, with a deployer identity
and a cross-install deploy lock that exist because two apps pointed at one host
would otherwise trade the sidecar back and forth indefinitely.

**And nothing provisions one.** No Terraform, no Ansible, no cloud-init, no
image, and no agent workload anywhere in the Helm chart — the chart deploys the
Switch *server* and nothing else. Host *setup* exists, as an ordered plan of
install steps, but it is manual by design, per operator, with deliberately no
run-everything control. The documented provisioning step is to go and obtain a
Linux machine you can reach over SSH.

Note also that a Switch Console-managed server on a remote host is **not** the
answer to this. It binds to the host's loopback and is reached through a port
forward belonging to one install, with its credentials in that install's secret
store. The documentation puts it plainly: *"Your agents are shareable; the server
is yours."* A team that wants a shared server deploys one properly, with the
chart. That is a separate, well-supported thing from where an agent runs.

#### The three options, and the trade that decides it

**1. A shared host, team-owned by convention.** Put the machine in team
infrastructure with a shared service account, give the rotation SSH access, and
pick one working directory. This works today, and better than it first appears:
the agent's credentials and the sidecar's state live *on the host*, not in
anyone's app, and Switch Console can adopt an existing remote agent by reading
them over SFTP. So any engineer with SSH can take the agent over. What is missing
is that nothing records the host as shared — each of them holds a private record
of it — and the reboot gap still needs a service unit somebody writes by hand.

**2. No host at all: a server-side connector.** Connector agents run inside
Switch's own process. They are always-on, they survive a server restart, they
need no machine anywhere, and they are registered `owner_only=False` by
construction — the code comment could have been written for this problem: *"a
service the deployment offers everyone, not one person's assistant."* The single
connector type today is OpenCode, which talks to an OpenCode server over HTTP, so
a team could run one on its own infrastructure, expose exactly one agent through
the allowlist, and have a responder that belongs to the deployment rather than to
a person.

**3. Build the missing piece** — a host record that lives server-side, or a
containerised sidecar the chart could schedule. Neither exists in any form today;
the sidecar assumes SSH, tmux and SFTP delivery.

**The trade between 1 and 2 is the decision, and it is uncomfortable.** A
connector agent has **no pre-invocation mediation and auto-approves permissions
permanently** — tool calls are reported after the fact rather than gated, and the
permission response is set to `"always"` so a given tool is never re-asked. It
also gives up hooks, the task protocol, compact and interrupt, and it is
undocumented in the user-facing docs.

So: **the option that solves ownership is the one with the least governance, and
the option with full mediation is the one that has to live on somebody's box.**
For an agent with shell access, addressed by six people during the worst hour of
the quarter, that is not a footnote.

**Recommendation: take option 1 now** — a shared host in team infrastructure,
under a service account, never a personal VM — and treat option 2 as the right
destination once a connector agent can be governed. Option 1 keeps hook
mediation, keeps the Claude Code host the rest of this design assumes, and its
weaknesses (G22, G24) are small, well-understood pieces of work. Option 2's
weakness is that it removes the only enforcement layer standing between a shared
agent and a production system, which is the wrong thing to trade away first.

## Making the agent user-agnostic

The rotation is the problem the agent has to survive. Six engineers take the
pager in turn; the agent must be the same agent for all of them, reachable by
whoever is on duty, and not degraded because the person who set it up is on
holiday.

### What the agent does, and does not, do

In the hub and the war room it answers lookups, drafts situation reports, keeps
the timeline, greets arrivals, and builds and archives the room. It does not
page, does not set severity, does not resolve, does not decide, and does not
touch production. The SOP grants *humans* the authority to roll back and push
emergency fixes; extending that to a shared agent that six people can address and
nobody can attribute would be the worst decision available here. See
[the rule that makes it safe](#the-rule-that-makes-it-safe).

### What the existing shared agents get right

`flint-tracker` and the workforce managers are the same shape, read from the live
instance rather than assumed:

- **A name with no owner suffix** — `flint-tracker`, not
  `claude-code.<project>.<person>`. The name is the routing key for everything:
  mentions, the Slack user group the bridge mints, room aliases, `target_names`.
  `display_name` routes nothing.
- **`auto_session` with a watcher on a shared always-on host**, not a laptop. The
  agent is online regardless of whose turn it is, whether their machine is
  asleep, or whether they have ever installed Switch Console. This is the
  load-bearing one, and it is also what makes the PagerDuty MCP install
  tractable — one host to configure.
- **An open addressing policy.** A rotating group cannot be enumerated, so the
  policy must not try.
- **Membership by invitation.** The agent belongs to rooms, not to a room.
- **A description written at the reader**, telling a stranger what to ask it.

Copy all of that.

### What breaks

**1. Owner permissions.** An agent inherits *exactly* its owner's permissions,
and `User.role == "admin"` is a global bypass on every read, write and delete. The
existing shared agents are owned by the deployment's `Admin` account, so each has
unbounded authority over every reference, document, package and room in the
tenant. That is a deliberate house pattern and it is tolerable for agents that
read and summarise. It is worse for a responder: the moment its blast radius is
widest is exactly the moment it is unbounded, addressed by six people under time
pressure. Own it with a dedicated **non-admin** service user instead.

**2. There is nothing good to own it with.** Switch has one shared-owner
construct — the synthetic bootstrap account that owns agents registered with the
deployment-wide token. It is deliberately non-admin, which is right, and on a
password deployment nobody can sign in as it. (On an OIDC deployment an identity
provider asserting that address would link to it, but that is an accident, not a
supported way to hold a shared identity.)

The consequence is narrower than "unmanageable" and still bad. An admin *can*
manage a bootstrap-owned agent — options, addressing policy, deletion. What
nobody can do is **reveal its credential**, because credential reveal is the one
check with strict owner equality and no admin bypass. So a bootstrap-owned
responder has a token that can be rotated and never read. [Gaps](#gaps) G11.

Ownership is also permanent: `owner_id` is set at registration and no endpoint
changes it. Registering the responder under a person "just for now" means it is
theirs until someone runs an `UPDATE`.

And note that user-agnostic cannot mean *ownerless*. An agent with no owner
cannot create a reference, attach one, list references, or attach resources when
creating a room — every one of those paths resolves the agent to its owner and
fails. It cannot even edit itself over MCP, where the guard compares two `None`s
and refuses. **User-agnostic means owned by a non-person, not owned by nobody.**

**3. The default addressing policy locks the rotation out.** Every agent
registered through any HTTP path is created owner-only with an empty
allowed-agents list. `register_agent` takes an `owner_only=False` parameter and no
wire path passes it — the sole caller is server-side connector registration,
whose comment is this design's precedent:

> A server-side connector agent is a service the deployment offers everyone, not
> one person's assistant; it is owned by whoever holds the registration token
> only in the bookkeeping sense. Owner-only would make it answer to that account
> alone.

So the responder is born locked and must be widened afterwards through
`PUT /agents/{id}/addressing-policy`. The landmine: the gateway's React policy
editor models only the four id-shaped dimensions, so the symbolic `owner` and
`owner_agents` rules are dropped from any rule it saves. It does disable Save on
a rule that can never match, so the agent cannot be bricked outright — but the
ordinary action, adding an allowed agent to the default policy, silently drops
`owner: true` and locks the human owner out. Switch Console's editor round-trips
them correctly; the gateway's does not. [Gaps](#gaps) G12.

**4. The offline nudge wakes the wrong person.** Addressed with nothing to start
it, an `auto_session` agent posts on its own behalf, naming its *owner*:

> `@owner` — I'm not online in this room, and `@asker` needs me. Open Switch
> Console to bring me online here.

The code's comment explains the reasoning — "the fix is for the OWNER to open it,
and nobody else in the room can act" — which is right for a personal agent and
exactly wrong for a shared one. At 03:00 the hub names a service account nobody
watches. Running the watcher on an always-on host makes this rare rather than
fixing it. [Gaps](#gaps) G13.

**5. One credential, no rotation, no per-holder revocation.** One agent has one
API key row. No rotation endpoint — the only rotation is re-registration with
overwrite, which deletes the old row and breaks every holder at once. Reveal is
owner-only with no admin bypass. And the token is a bearer credential in a
plaintext file in the agent's working directory, which the repository's own
documentation calls a known exposure.

The consequence is a rule, not a fix: **the responder's credential lives in
exactly one place, on the shared host, and is never distributed.** Handing it to
six laptops means six copies of a token nobody can individually revoke, on
machines that leave with their owners. [Gaps](#gaps) G14.

This also settles a mechanical question. Two people *can* run sessions as the
same agent — identity is per directory, not per machine, and an agent may hold up
to 32 connections. But at most one session may act in a given room, and
`connect_to_room` always takes over: the newcomer wins and is warned what it
displaced, while the incumbent simply stops receiving that room's events, with a
bare subscription change and no reason attached. Two responders starting sessions
during one incident would evict each other in turn. One process, one host.

**6. Nothing records which human drove it.** No actor on connections, sessions,
runtime state, leases or messages; a message is attributed to the agent. For most
agents that is a shrug. For incident response it is not, because the postmortem's
second question is always "who did what, when". [Gaps](#gaps) G15.

### Roles, correctly scoped

Room roles are the right tool here, but only at the hub, and it is worth being
exact about why — the constraint is easy to design past and expensive to discover
late.

**In the hub: use one.** An exclusive `responder` role is the same thin shell the
workstream hubs use — the lease plus `@responder` addressing, so anyone reaches
whoever is currently coordinating without knowing which agent that is. It
auto-releases within about six seconds of a holder's session dying, so another
agent can take over with no manual handoff. That is genuine failover, and it is
exactly the "address the duty, not the person" semantics the SOP wants.

**In a war room: do not.** A role lease is unique per *agent*, globally — not per
room, not per session. One shared responder can therefore hold one role across
the whole instance. If it holds `responder` in the hub, it cannot also hold
`scribe` in a war room, and with two concurrent incidents it could be scribe in
only one of them anyway. Two sessions of the same agent assuming the same role is
treated as an idempotent re-assume, so roles arbitrate nothing between them.
[Gaps](#gaps) G16.

**Humans cannot hold roles at all** — assuming a role is an agent operation — so
"incident commander" cannot be a role. And there is no eligibility control: the
role model carries an `eligibility` field documented as a forward-looking hook
and read by nothing, so any room member may assume any role. [Gaps](#gaps) G17.

Hence the shape: `responder` in the hub, held by the shared agent; `scribe`
defined in each war room and assigned to nobody, there for a responder's own
coding agent to pick up; incident commander a human convention written into the
room's instructions.

### The recommendation

**One shared responder agent per product, owned by a dedicated non-admin service
user, running `auto_session` on shared always-on infrastructure with the
PagerDuty MCP server installed, holding an exclusive `responder` role in the
product's incident hub, with an open addressing policy, and never run from an
engineer's machine.**

| Setting | Value | Why |
| --- | --- | --- |
| `name` | `<product>-responder` | The routing key. No person in it. |
| owner | a dedicated service user, **not** an admin | The agent inherits its owner's permissions exactly. |
| `connection_model` | `auto_session` | Comes online when addressed; nobody has to remember to start it. |
| host | one always-on machine, PagerDuty MCP installed | Online regardless of whose turn it is; one place to configure the integration. |
| credential | one copy, on that host | Cannot be revoked per holder, so do not spread it. |
| addressing policy | open | A rotation cannot be enumerated — and a bot-posted mention is refused under any restricted policy. |
| role | exclusive `responder`, in the hub only | Address the duty, not the agent. One lease per agent, so the hub gets it. |
| war rooms | built per incident, archived after the postmortem | Nothing about the agent changes per incident. |

Two alternatives, and why not:

- **One responder agent per engineer.** Real per-human attribution and real role
  arbitration. But six registrations, six addressing policies, six credentials
  and six PagerDuty MCP installs to keep consistent; it churns on every rotation
  change; and each agent is still personally owned, so the day someone leaves,
  their responder leaves too. It solves attribution by giving up the shared
  identity that was the requirement.
- **Own the shared agent with the Admin account**, as the existing shared agents
  do. One fewer problem today, in exchange for an agent with unbounded authority
  over every room and resource, addressable by anyone, during the worst hour of
  the quarter. If G11 cannot be closed before the first incident, take this
  *knowingly and temporarily* — the mitigation being that the agent has no
  production access and no write path outside its rooms.

### The rule that makes it safe

Because nothing records which human drove the agent, the room transcript has to
carry the attribution instead:

> **The responder takes no consequential action that a human did not ask for, in
> the room, in writing.** Everything it does is a read, or a draft posted back to
> the room for a human to act on. It never posts to the stakeholder channel,
> never changes the incident record, and never runs anything against production.

Under that rule the room *is* the audit log: every action has a message above it
from the person who asked. Relax the rule and G15 becomes a real hole. The rule
belongs in the hub's instructions and in the agent's own definition.

Note that this rule is what makes PagerDuty access safe to grant. Reading
schedules and incidents is a lookup. Acknowledging, changing severity or
resolving is a decision, and those stay with the human even though the MCP server
would happily let the agent do them — so the `pagerduty` reference type's
instructions must say so explicitly, because the tool surface will not.

## Gaps

Twenty-six, grouped by what they block. Each says what is missing, why it matters
here, and a ticket to file. Sizes are rough: **S** is days, **M** is a sprint,
**L** is a project. The numbers are stable identifiers, not an ordering — they
are in the order they were found, and the grouping is what to read by.

**Read the header of group A first.** The gap that looked hardest is largely not
a gap.

### A. Knowing who is on call — mostly closed

Switch has no rotation, schedule or concept of duty, and after working the design
through, **it should not acquire one**. The agent asks PagerDuty and passes the
answer to `create_room`. What remains is smaller:

**G1 — There is no identity mapping across systems.**
PagerDuty knows a person by one name, Slack by another, Switch by a third.
`add_users_to_room` resolves usernames against external users the bridge has
already seen; a name it cannot place is returned as unresolved rather than
raising, so a war room can quietly come up with four of the five people it should
have. There is also no way at all to invite someone the bridge has never seen.

> **Proposed ticket:** *Surface unresolved invitees as a first-class result* —
> so a caller must handle "these three could not be added" rather than reading it
> out of a list. **S**

> **Proposed follow-up:** *Cross-system identity mapping* — a per-bridge map from
> an external identity to a Switch user, so an agent holding a PagerDuty
> user can find the Slack account. Until then the mapping lives in the hub's
> bindings block, by hand. **M**

### B. The template format

Only relevant if the template path is taken. The agent path needs none of it.

**G2 — The registry cannot instantiate what it stores.**
`POST /rooms/from-yaml` provisions from a document in the request body; the
registry stores documents; nothing joins them. Using a registered template means
fetching its content and posting it back.

> **Proposed ticket:** *Instantiate a stored template by id* —
> `POST /templates/{id}/instantiate` taking `inputs`. **S**

**G3 — The dashboard cannot supply parameter inputs.**
The create-from-YAML page posts raw YAML with no `inputs`, so from the UI only a
template whose every parameter has a default works. An incident template has no
useful defaults. Caveat: the linter's own comments refer to "a document the
Console wizard renders happily", implying a client that does collect inputs;
nothing in this tree posts to `/rooms/from-yaml` or renders a `params:` block, so
either that wizard is unmerged or lives elsewhere. If it ships, this narrows to
"the gateway cannot".

> **Proposed ticket:** *Parameter form for template instantiation* — render the
> declared `params:` as a form, using the `description` field that is currently
> stored and never displayed. **S**

**G4 — A parameter cannot hold a list.**
Types are `string`, `number`, `boolean`, `enum`. `agents:` and `users:` are
lists, so membership cannot be parameterised: `"alice,bob"` becomes one entry,
which in `users:` resolves to nobody and in `agents:` is a hard `Unknown agents:`
failure that aborts provisioning.

> **Proposed ticket:** *List-typed template parameters* — whole-field
> substitution that splices into the surrounding list. **M**

**G9 — A room template is strictly less capable than the room creation it
wraps.**
`RoomCreateConfig` carries `aliases`, `linked_rooms`, `group_id`, `package_ids`
and `join_event_listeners`, and `create_room` accepts every one. The template
provisioner populates none. The first three arrive with group templates;
`join_event_listeners` arrives nowhere. Nothing needs designing — the fields
already exist and are already validated.

> **Proposed ticket:** *Pass the remaining room fields through the template
> provisioner*, `join_event_listeners` first. **S**

> **Proposed ticket:** *Land group templates* — merge
> `origin/work/group-templates`: `group:`/`rooms:`/`links:`, per-room `aliases:`,
> and dict-key interpolation. **M**

**G10 — Omitting `bridge:` silently means "the default bridge", and breaks
`users:`.**
The comment on the template's `bridge` field says to omit it for an internal-only
room. Omitting it falls through to the instance default — or to no bridge with no
default configured, or to a hard failure with a default configured but not
running. (`internal_only`'s own documentation is accurate; the misleading comment
is on the template side.) And the guard rejecting `users:` on an unbridged room
tests the template's resolved bridge id, so `users:` with no `bridge:` is refused
even though the room would have been bridged.

> **Proposed ticket:** *Fix `bridge:` omission semantics* — resolve the default
> before the `users:` guard, and add an explicit `internal_only:` key. **S**

**A hazard, not a gap.** A `{word}` no parameter declares is left verbatim, on
purpose, so JSON braces in document content survive. A typo in a placeholder name
does not error — it ships into the created room. Lint before registering; the
registry blocks only three findings and treats the rest as advice.

### C. Driving the flow

**G5 — No agent operation touches templates, and no channel command declares an
incident.**
The agent surface has 46 operations, none template-related; the in-room command
set has 21, none creating a room. An agent *can* open a war room — `create_room`
is an operation, which is what this design uses — but it cannot open one from the
reviewed, version-controlled template. And an on-call engineer in the hub cannot
declare from the channel with a command; they address the agent in prose, which
works, but is less discoverable than `/declare-incident`.

> **Proposed ticket:** *`create_room_from_yaml` agent operation* — land the
> operation on `origin/work/group-templates`, extended to take a template id
> (needs G2). **S**

> **Proposed ticket:** *`!declare-incident` in-room command* — positional inputs,
> posts the new room's link back. **M**

**G6 — There is no generic alert ingress.**
Switch does listen for inbound HTTP from a platform and verify a signed caller —
the Teams bridge does exactly that — so the machinery exists. What does not is
anything generic: no endpoint accepting a third-party alert payload and mapping
it to a Switch action. This design does not need one (it declares by pull), but a
team wanting fully automatic room creation does.

> **Proposed ticket:** *Incident intake webhook* — a signed inbound endpoint
> mapping an alerting payload to a room build, field mapping configured per
> source. **L**

**G7 — There is no scheduling primitive a *room* can use.**
Switch runs periodic work internally; none of it is reachable from a room, and
nothing in Switch can wake an agent on a clock.

The agent *host* may have a scheduler — Claude Code has cron — and used as a
frequent poll rather than an alarm it covers most of this: see
[Cadence](#cadence-and-the-thing-that-nudges). What a host timer cannot do is the
part that makes this a gap rather than an inconvenience.

It **shares a failure mode with the agent**. A durable job still needs a live
session to fire into, so a host restart or a crashed session takes the clock away
along with the thing the clock was supposed to prompt — silently. It is also
invisible to the room: nobody can see that an update is scheduled, confirm it, or
cancel it, and an orphaned job wakes an agent for rooms that closed days ago.

A room-scoped schedule would be visible to everyone in the room, cancellable by
any of them, disposed of with the room, and — the point — kept somewhere that
does not go down when the agent does.

> **Proposed ticket:** *Scheduled room actions* — a room-scoped recurring trigger
> that posts a message or addresses an agent, created with the room and disposed
> of with it, and visible to everyone in the room. **L**

**G8 — There is no relay between rooms.**
Linked rooms are metadata: a pointer with a label. The SOP wants situation reports
in both the hub and the stakeholder channel. An agent can read another room
without connecting, but posting requires connecting, which means leaving the war
room mid-incident.

> **Proposed ticket:** *Mirror a message to a linked room* — post to a room the
> agent is a member of without moving its connection, attributed and marked as a
> mirror. **M**

### D. The shared agent

**G11 — There is no provisionable service account.**
The recommendation rests on owning the responder with a non-person, non-admin
user. The only shared-owner construct is the synthetic bootstrap account, which
on a password deployment nobody can sign in as. An admin can still manage its
agents; nobody can reveal their credentials, because credential reveal is the one
check with strict owner equality and no admin bypass. The alternatives are a real
person (defeats the purpose) or the Admin account (a global bypass over every
room and resource). **This is the gap the responder design depends on.**

> **Proposed ticket:** *Service accounts* — a non-interactive user that can own
> agents and resources, with authentication a team can hold jointly, and no admin
> role. **M**

> **Proposed ticket:** *Transfer agent ownership* — an owner-or-admin endpoint
> setting `owner_id`. There is none, so an agent registered under the wrong
> account stays there. **S**

**G12 — The gateway's addressing-policy editor drops owner rules.**
It models only the four id-shaped dimensions, so `owner` / `owner_agents` are
dropped from any rule it saves. It disables Save on an unmatchable rule, so the
agent cannot be bricked outright; the reachable damage is quieter — widening the
default owner-only policy by adding an allowed agent saves a policy that no
longer admits the owner. Switch Console's editor is correct.

> **Proposed ticket:** *Preserve symbolic rules in the gateway policy editor*,
> and warn when a saved policy admits nobody. **S**

**G13 — The offline nudge names the owner, not whoever can act.**
An `auto_session` agent addressed with nothing to start it tells the room to go
and wake its owner. For a shared responder that is a service account nobody
watches.

> **Proposed ticket:** *Escalation target for an offline shared agent* — address
> the nudge to a room-configured target when the agent has no personal owner.
> **S**

**G14 — One credential per agent; no rotation, no per-holder revocation.**
One key row per agent. No rotation endpoint — only re-registration with
overwrite, which breaks every holder at once. Reveal is owner-only. The token is a
bearer credential in a plaintext file in the working directory.

> **Proposed ticket:** *Per-holder agent credentials* — several named,
> independently revocable keys per agent, each attributable, with a rotation
> endpoint that does not break the others. **M**

**G15 — Nothing records which human drove a session.**
No actor on connections, sessions, runtime state, leases or messages. A shared
agent's actions are attributable to the agent and nobody else. Mitigated here by
convention, and conventions are not enforcement.

> **Proposed ticket:** *Record the operator behind a session* — capture an actor
> at session registration and carry it onto messages that session sends. **M**

**G16 — A role lease is held per agent, globally.**
Unique on the agent, not the room and not the session. One agent holds one role
across the whole instance, so a responder holding `responder` in the hub cannot
also hold `scribe` in a war room. Two sessions of one agent assuming the same
role is an idempotent re-assume, so roles arbitrate nothing between them.

> **Proposed ticket:** *Scope a role lease to (agent, room)* — and decide
> explicitly what two sessions of one agent assuming one role should mean. **M**

**G17 — Role eligibility is declared and unused; humans cannot hold roles.**
`RoomRole.eligibility` exists, is documented as a forward-looking hook, and is
read by nothing — any room member may assume any role. And roles are assumable
only by agents, so "incident commander" cannot be one.

> **Proposed ticket:** *Enforce role eligibility.* **S**

> **Proposed ticket:** *Human-holdable roles* — let a person claim a room role
> from the bridged channel, so `@incident-commander` reaches a human. **L**

### E. Third-party capability

**G19 — MCP is per-machine, not per-agent.**
Every connector plugin bundles one MCP server; every provider declares MCP scope
as `global` and the capability schema admits no other value. Switch Console
writes a per-agent launch profile carrying model, effort and instructions, and
deliberately registers no MCP server; the MCP management UI was removed and the
remaining config adapters have no live callers. So giving the responder PagerDuty
means giving it to every agent on that host. Workable — run the responder on its
own host — but it is why "give this one agent a tool" is a machine-provisioning
task rather than a Switch setting.

> **Proposed ticket:** *Per-agent MCP servers* — a per-agent scope in the
> capability schema and a writer per provider. Note Codex refuses to load a
> config that layers a base entry onto a plugin-provided server, so this is not
> uniform across providers. **L**

**G20 — There is no agent-scoped secret storage.**
Switch encrypts its own API keys and bridge tokens; a server-side connector's
config sits in plain JSONB. There is nothing for a third-party credential
belonging to one agent. A PagerDuty token lives in the host environment, or in
Switch Console's per-provider environment map, which is plaintext and shared
across every agent of that provider. Switch neither scopes, rotates nor audits
it.

> **Proposed ticket:** *Agent-scoped third-party credentials* — encrypted at
> rest, injected into that agent's sessions only, revocable independently of the
> agent's own key. **M**

### F. Fidelity of delivery

**G21 — A third-party app's message reaches Switch lossily, and its edits not at
all.**
Rich Slack blocks are read only when the message has no plain-text body, and even
then only `section`, `header` and `rich_text` — `context` and `actions` blocks
are discarded, which is where PagerDuty puts service, urgency, assignee and its
buttons. Attachments are read only if no block yielded text. And
`message_changed` / `message_deleted` are dropped entirely, so an alert edited in
place to "Resolved" leaves Switch's copy saying it is open. A message whose
readable body comes out empty is still relayed, as an empty post.

This design routes around it by declaring through a human rather than parsing
alerts, but any team that wires alerts straight into a room will hit it.

> **Proposed ticket:** *Extend Block Kit extraction* — read `context` blocks and
> merge attachments rather than treating them as a fallback; drop a message whose
> extracted body is empty rather than relaying it. **S**

> **Proposed ticket:** *Bridge message edits* — relay `message_changed` as an
> edit, or at minimum as a new message noting the original was amended. **M**

**G23 — Nothing detects a host that cannot receive pushed events.**
An agent registered as session-addressable whose host authenticates through a
third-party provider silently receives nothing: the enabling flag is ignored with
no error. Switch records the distinction at registration and the internals
documentation says outright that nothing detects the mismatch afterwards. The
room waits for an agent that will never answer.

> **Proposed ticket:** *Detect a session that cannot receive events* — have the
> runtime confirm delivery once at session start and downgrade the agent to
> passive, loudly, when it cannot. **S**

### G. Where the agent runs

**G22 — A remote agent does not survive a host reboot.**
Switch Console deploys the sidecar into a tmux session on the host; nothing
registers a service, so after a restart the agent and any Console-managed server
on that host stay down until someone starts them by hand. Every other gap here
degrades a feature. This one makes the responder absent, which is the only
requirement it really has.

> **Proposed ticket:** *Supervise the remote sidecar* — install it as a user
> service (systemd `--user`, or the platform equivalent) so a host reboot brings
> it back, and surface "host up, sidecar down" as a distinct state rather than an
> unreachable agent. **M**

**G24 — A remote host is one person's record, not a team resource.**
The host record lives in Switch Console's own local database — an SSH alias and a
display name, with no user, tenant or server-side row. Two engineers onboarding
the same machine hold two unrelated records and cannot see each other's.
Everything that manages the host — setup steps, sidecar redeploy, session restart
— runs over that person's SSH connection. The agent keeps working when they are
away; nothing about it can be *managed* without them, unless a colleague
independently onboards the same alias.

> **Proposed ticket:** *Server-side host records* — move the host to Switch so it
> is a shared, tenant-scoped resource an operator can see and manage without
> having onboarded it privately. **L**

> **Proposed interim:** document the shared-host convention — team service
> account, one working directory, rotation-wide SSH — and the adoption path,
> since it works today and nothing says so. **S**

**G25 — Nothing provisions an agent host.**
No Terraform, Ansible, cloud-init or image; no agent workload in the Helm chart,
which deploys the server only. Host setup exists but is a manual per-operator
walkthrough with deliberately no run-everything control. The documented
provisioning step is to go and obtain a Linux machine. For one hobby agent that
is fine; for an agent a rotation depends on, "somebody set up a box once" is not
an operational posture.

> **Proposed ticket:** *A reference agent host* — a cloud-init or container
> definition that stands up a host with the dependencies, the connector and a
> supervised sidecar, so an agent host is reproducible rather than
> hand-assembled. **M**

**G26 — The only host-free option has no tool mediation.**
A server-side connector agent is the one team-owned, always-on shape Switch has —
and it declares no pre-invocation mediation and auto-approves permissions with
`"always"`, so tool calls are reported after the fact rather than gated. It also
has no hooks, no task protocol, and no compact or interrupt. The result is that
the ownership problem and the governance problem cannot currently be solved at
the same time.

> **Proposed ticket:** *Mediation for server-side connector agents* — gate tool
> calls through the same pre-invocation path client-side agents use, so a
> deployment-owned agent is not automatically the least governed one. **M**

### H. Closing the incident out

**G18 — There is no transcript export.**
The postmortem is written from the room, but no endpoint produces a room's
history: the gateway exposes a room's *configuration* as YAML and nothing else,
and reading messages is an agent-only operation. In practice the responder can
page back through the room and post a timeline as an attachment, which is good
enough — the cheapest gap here and the least urgent.

> **Proposed ticket:** *Export a room transcript* — a downloadable, paginated
> history export for a room a user can read. **S**

## What to build first

**Nothing.** That is the main finding, and it changed during the design.

Because the room is built by an agent calling `create_room`, and because
PagerDuty is reached the way Jira already is, **this SOP can run on Switch today
with no change to Switch at all.** Standing it up is configuration and one agent
definition:

1. Adopt the product's alert channel as the incident hub. Write its instruction
   card: the SOP, the room-writing rules, the bindings block — with the
   **internal** bridge id pinned.
2. Define the exclusive `responder` role in the hub.
3. Stand up an always-on host **in team infrastructure, under a service account
   the rotation shares — not anyone's personal VM** — and register the responder
   as a **remote** agent on it, so the sidecar holds its event stream and it
   stays up with no app running. Widen its addressing policy **through the API,
   not the dashboard** (G12). Write a service unit for the sidecar by hand until
   G22 lands.
4. Install a PagerDuty MCP server on that host and put a `pagerduty` reference
   type and its references in the hub.
5. Register the room YAML as a template so the shape is reviewable — as
   documentation, not as the mechanism.
6. Put the SITREP cadence in a scheduled Slack workflow that mentions the agent.

Three compromises in that list, all worth naming out loud rather than
discovering. **Identity**: until G11 exists the responder is owned by a person or
by Admin, and neither is right. **Host**: the machine is the team's by convention
only — each engineer holds a private record of it (G24) and nothing provisions it
(G25). **Availability**: a reboot takes the responder offline until someone
notices (G22).

Those three are the same problem seen three times. A shared agent needs a
team-owned identity, a team-owned host and team-owned credentials, and today each
of them resolves to a particular person's. Nothing about incident response caused
that — it is the first use case where it stops being untidy and starts being
unacceptable.

**Then, in order of value per unit of work:**

1. **G22 — supervise the remote sidecar.** Moved to the top after the hosting
   decision. Everything else on this list degrades a feature; this one makes the
   responder absent, and absent at 03:00 on a Sunday is the failure the whole
   design exists to prevent.
2. **G11 — a service account.** Small, and the recommendation is unsound without
   it. Every day it is missing is a day the responder is either one person's
   agent or an admin.
3. **G12 — the policy editor bug.** Hours of work, and it otherwise gets
   discovered by whoever widens the responder's policy, during an incident.
4. **G23 — detect a session that cannot receive events.** Small, and it removes
   the only failure mode in this document where the room believes an agent is
   listening and it is not.
5. **G1 — surface unresolved invitees.** Small, and it turns "the war room quietly
   came up one person short" into something someone notices.
6. **G8 — mirror to a linked room.** Removes the SOP's most tedious manual step,
   posting the same situation report into two channels.
7. **G9 — pass the remaining room fields through the template provisioner**,
   `join_event_listeners` first. Closes the distance between the reviewable
   artifact and the capable one.
8. **G7 — scheduled room actions.** Retires the per-incident Slack workflow.
9. **G25 — a reference agent host**, then **G24 — server-side host records.** The
   first makes an agent host reproducible instead of hand-assembled; the second
   makes it a thing the team owns rather than a row in one person's app. Both are
   larger, and neither blocks a first incident — but together they are what turns
   "we run a responder" from a favour someone is doing into infrastructure.
10. Everything else, as it starts to hurt.

The honest summary: **the design needs no Switch changes to run, and two small
ones — a supervised sidecar and a service account — before anyone should depend
on it.** Neither is an incident-response problem; both are about a shared agent
needing a substrate that belongs to the team. That is a good sign for the SOP —
it is not blocked on Switch growing any new concepts — and a fair warning for
Switch, because the same three gaps will surface for every shared agent after
this one.
