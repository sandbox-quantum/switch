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

## The war-room template

The template is the deliverable that makes this reusable. One document, stored
in the registry, instantiated per incident with the incident's particulars as
inputs, and reusable across products because everything product-specific is a
parameter.

### What the template feature actually is today

Before the YAML, the state of the feature it is built on, because two of the
three pieces named on the ticket are not on `main` and the design has to be
honest about which half exists.

**Merged and working** (`core/switch_core/rooms_yaml.py`):

- A single-room YAML document with exactly three top-level keys — `room:`
  (required), `params:` and `version:`. `version:` is parsed, type-checked and
  then ignored. An unrecognised top-level key is a hard error.
- Typed parameters: `string`, `number`, `boolean`, `enum`, each with an optional
  `description` and `default`. There is no `required:` key — a parameter is
  required exactly when it has no default.
- `{name}` interpolation over the `room:` block. Two modes: if a field is
  *entirely* one placeholder, the parameter's typed value is substituted whole,
  which is how an `enum` can fill `channel_type:`; otherwise each placeholder is
  stringified in place.
- A registry (`core/switch_core/gateway/templates.py`): store, list, fetch,
  patch, delete and lint a template, with names unique per owner, listing
  visible tenant-wide and mutation restricted to the owner or an admin.

**Not merged.** Group templates — `group:` / `rooms:` / `links:`, per-room
agent aliases in YAML, and interpolation into dict *keys* — are on
`origin/work/group-templates`, along with `create_room_from_yaml`, the operation
that would let an agent instantiate a template at all. Template built-ins like
`{$creator}` are on a different branch again.

**The two halves do not meet.** The registry stores documents; `POST
/rooms/from-yaml` provisions from a document supplied in the request body.
Nothing fetches a stored template by id and provisions it. Instantiating a
registered template today means downloading its content and posting it back —
and the dashboard's create-from-YAML page posts raw YAML with no `inputs`, so
*from the UI, only a template whose parameters all have defaults can be used at
all*. Passing inputs requires an API client sending the JSON body form. For a
template whose entire purpose is per-incident particulars, that is disqualifying
on its own; it is [Gaps](#gaps) G2 and G3.

The template below is therefore written twice: once in the merged format, so it
can be built and used now, and once in the group format, as the target.

### Parameters

Eleven, in three groups.

**The incident** — supplied per instantiation, no defaults, all required:

| Parameter | Type | What it is |
| --- | --- | --- |
| `incident_id` | string | The incident record's id, e.g. `1287`. Goes in the room name so the channel is greppable against PagerDuty. |
| `severity` | enum | `sev0` \| `sev1` \| `sev2`. Drives the update cadence named in the room instructions. |
| `service` | string | The affected service. Drives the owner lookup and the runbook section. |
| `summary` | string | One line: what is broken. Becomes the room description. |
| `incident_url` | string | Link to the incident record. The room's pointer at the system of record. |

**The product** — supplied per product, and the reason this is reusable rather
than one team's room:

| Parameter | Type | Default | What it is |
| --- | --- | --- | --- |
| `product` | string | — | Short product name. Prefixes the room name. |
| `alert_channel` | string | — | Where alerts land and situation reports are posted. |
| `comms_channel` | string | — | Where stakeholder updates go. |
| `runbook_reference` | string | — | Name of an existing Switch reference pointing at the product's runbooks. |
| `responder_agent` | string | — | The shared responder agent's name. |

**The deployment** — sane defaults, rarely overridden:

| Parameter | Type | Default | What it is |
| --- | --- | --- | --- |
| `bridge` | string | — | Collaboration bridge display name. Required; see the note on omitting it below. |
| `visibility` | enum | `channel_public` | `channel_public` \| `channel_private`. Public by default, per the SOP. |

Two parameters that are conspicuously *not* here, because they cannot be:

- **The responders.** `users:` takes a list, and a parameter cannot hold one —
  `ParamSpec.type` is `string | number | boolean | enum` and nothing else. A
  parameter set to `"alice,bob"` interpolates into a single username
  `alice,bob`, which resolves to nobody. So the invitee list is either
  hard-coded in the template or spread across one parameter per seat. Neither is
  acceptable for a rotation. [Gaps](#gaps) G4.
- **Who is on call.** Nothing in Switch knows. [Gaps](#gaps) G1, and the
  hardest problem in this document.

### The template, in the format that works on `main` today

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

  # ── the product ───────────────────────────────────────────────────────────
  product:
    type: string
    description: Short product name; prefixes the room and channel name
  alert_channel:
    type: string
    description: Channel where alerts land and situation reports are posted
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
    description: War rooms are public by default so stakeholders can read along

room:
  name: "{product} incident {incident_id}"
  description: "{severity} · {service} · {summary} · {incident_url}"
  bridge: "{bridge}"
  channel_type: "{visibility}"
  read_visibility: public
  write_visibility: public

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
      {alert_channel} and {comms_channel} — you do not post to those channels.
    - Keep a running timeline as the incident moves: what changed, when, who
      did it. The postmortem is written from it.
    - Say what you do not know. During an incident a confident wrong answer
      costs more than silence.
    - Cadence for {severity}: sev0 updates hourly, sev1 every four hours, sev2
      on change only. You will be nudged; if a nudge is late, say so.

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

        Filled in per product at instantiation. One row per service:
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

Notes on choices in that document that are not arbitrary:

- **`channel_type: "{visibility}"` is the whole-field form.** When a field is
  the *entire* placeholder, the parameter's typed value is substituted rather
  than stringified. For an `enum` the two are the same, but the distinction is
  the only way a `number` or `boolean` parameter can ever fill a non-string
  field, and it is worth knowing because a partial placeholder degrades to a
  string silently.
- **The room name slugifies cleanly.** Switch derives the Slack channel name with
  `re.sub(r"[^a-z0-9_-]", "-", name.lower()).strip("-")[:80]`
  (`core/switch_core/bridges/collaboration/slack/adapter.py:1366`). The SOP's
  bracketed convention — `[Product] [Incident #]` — would produce
  `product---incident-42`, with runs of hyphens where the punctuation was.
  `{product} incident {incident_id}` gives `product-incident-42`. Cosmetic, but
  channel names are what responders type under pressure.
- **`bridge:` is a required parameter and not omitted.** The field's own comment
  says to omit it for an internal-only room, and that is wrong: omitting it
  falls through to the instance default bridge. Worse, the guard that rejects
  `users:` on an unbridged room tests the template's resolved bridge id, so a
  template with `users:` and no `bridge:` is rejected even though the room would
  in fact have been bridged. Naming the bridge explicitly sidesteps both.
  [Gaps](#gaps) G10.
- **The `scribe` role is defined but nobody is told to take it.** See
  [Roles are the wrong tool for the on-call rotation](#roles-are-the-wrong-tool-for-the-on-call-rotation)
  — a role is held per *agent*, globally, so the shared responder can hold it in
  one incident at a time. It is there for a responder's own coding agent to
  assume, and the template does not assume it on anyone's behalf.
- **`write_visibility: public`** means any participant's owner can restructure
  the room — pull in another agent, attach a reference. During an incident that
  is the behaviour you want; it is also worth knowing you chose it.

This document is not illustrative. It was run through the shipped parser —
`ParamSpec`, `resolve_params`, `interpolate`, `RoomSpec` — with the inputs below,
and it resolves: `visibility` defaults to `channel_public`, every placeholder
substitutes with none left over, the room comes out named `flint incident 1287`,
and the Slack channel it would create is `flint-incident-1287`. Anything in this
section that turns out to be wrong is a bug in the design, not a typo in the
YAML.

### Instantiating it

Today, one call, with the inputs in a JSON body:

```
POST /rooms/from-yaml
Content-Type: application/json

{
  "yaml": "<the template text>",
  "inputs": {
    "incident_id": "1287",
    "severity": "sev0",
    "service": "ingestion",
    "summary": "Ingestion stalled; no new findings for 40 minutes",
    "incident_url": "https://<paging-system>/incidents/1287",
    "product": "flint",
    "alert_channel": "<alert hub>",
    "comms_channel": "<stakeholder channel>",
    "runbook_reference": "Flint runbooks",
    "responder_agent": "flint-responder",
    "bridge": "<bridge display name>"
  }
}
```

A missing required parameter, an undeclared input, or an `enum` value outside its
list fails with a 400 *before* anything is provisioned — there is no half-made
room to clean up. One trap to know: a `{word}` in the body that no parameter
declares is **left verbatim**, deliberately, so that JSON braces in a document's
content survive. A typo in a placeholder name does not error; it ships. Lint the
template (`POST /templates/validate`) before registering it, and read the
findings — the registry itself only refuses three of them.

### The target-state template, once group templates land

The merged format makes one room. The SOP wants the postmortem written after
recovery, and a comment in the source document observes there is no postmortem
process at all yet. A second, linked room is the better shape: the war room
closes when the incident does, and the postmortem room outlives it, holding the
review and the actions.

That needs `origin/work/group-templates`. In its format:

```yaml
version: 0

params:
  incident_id: { type: string }
  severity:    { type: enum, enum: [sev0, sev1, sev2] }
  service:     { type: string }
  summary:     { type: string }
  product:     { type: string }
  bridge:      { type: string }
  responder_agent: { type: string }

group:
  name: "{product} incident {incident_id}"
  description: "War room and postmortem for {product} incident {incident_id}"
  color: "#dc2626"

rooms:
  - name: "{product} incident {incident_id}"
    description: "{severity} · {service} · {summary}"
    bridge: "{bridge}"
    channel_type: channel_public
    agents: ["{responder_agent}"]
    aliases:
      "{responder_agent}": responder
    instructions: |
      ...as above...

  - name: "{product} incident {incident_id} postmortem"
    description: "Postmortem and review actions for {product} incident {incident_id}"
    bridge: "{bridge}"
    channel_type: channel_public
    agents: ["{responder_agent}"]
    aliases:
      "{responder_agent}": scribe
    instructions: |
      The incident is over. This room exists to produce the write-up and to
      track the actions out of it. Draft from the war room's timeline; a human
      owns the document. Blameless — name systems and decisions, never people.

links:
  - from: "{product} incident {incident_id}"
    to: "{product} incident {incident_id} postmortem"
    label: postmortem
  - from: "{product} incident {incident_id} postmortem"
    to: "{product} incident {incident_id}"
    label: incident
```

Three things that branch buys and `main` cannot express:

- **The group** — both rooms filed together, so an incident is one thing in the
  room tree rather than two rooms that happen to share a name prefix.
- **The links** — the postmortem room points back at the war room and vice
  versa, both directions, because a link is one-way.
- **The aliases** — `@responder` in the war room and `@scribe` in the postmortem
  room, both the same agent. This is the per-room identity the responder needs,
  and it is worth dwelling on: a rotating group should address a *function*, not
  an agent's name. Aliases also require interpolation into a dict *key*, which
  only that branch supports.

### What a template still cannot set

Measured against what a room can hold, the merged template reaches
`name`, `description`, `instructions`, `bridge`, `channel_type`, the two
visibilities, `agents`, `users`, `roles`, `references` and `docs`. It cannot
reach:

| Cannot set | Why it matters here |
| --- | --- |
| `aliases` | No `@responder` handle; responders must know the agent's real name. On the group branch. |
| `linked_rooms` | The war room cannot point at the alert hub, the stakeholder channel or the postmortem room. On the group branch. |
| `group_id` | Incidents cannot be filed under a product's group. On the group branch. |
| `join_event_listeners` | The responder cannot greet an arriving responder and orient them — the single highest-value automation in a war room, and it is unreachable. |
| `internal_only` | Not needed here (war rooms are bridged), but the field's documentation is actively misleading. |
| `package_ids` | No packaged tooling attached at creation. |
| room metadata | Nowhere structured to record severity or the incident id; both live in prose. |

`join_event_listeners` is the one to feel bad about. A war room's worst moment is
the fourth person arriving twenty minutes in and asking "what's the state?" — a
question the responder agent could answer automatically the instant they join,
and cannot, because the template cannot opt it into join events.
