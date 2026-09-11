# Incident response on Switch

How an on-call/incident-response SOP runs on Switch: the room shape, a reusable
room template that provisions a war room, and a responder agent that a rotating
on-call group can share without any one engineer owning it.

This is a design, not an implementation. Nothing here has been built. Where
Switch cannot do what the SOP needs, the gap is named and a ticket proposed
rather than designed around — [Gaps](#gaps) is the part to read if you read
only one section.

Written against `main` at `514d5ba4` (the template registry). Every claim about
how Switch behaves today was checked against the code on that commit rather than
recalled, and where a behaviour is surprising enough to be worth confirming, the
file it lives in is named. If a claim here has since gone stale, the commit is
the thing to diff against.

- [Scope](#scope)
- [The SOP, and the one place Switch appears in it](#the-sop-and-the-one-place-switch-appears-in-it)
- [Mapping the SOP onto rooms](#mapping-the-sop-onto-rooms)
- [The war-room template](#the-war-room-template)
- [The responder agent](#the-responder-agent)
- [Gaps](#gaps)
- [What to build first](#what-to-build-first)

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

Switch threads bridge to real platform threads everywhere it can — Slack replies
go out with a `thread_ts`, Discord gets a real thread, Telegram gets a forum
topic. The Slack difference is one of *rendering*: a threaded reply appears in
the channel only as a reply count under the original post rather than in the
main flow. So on a Slack-bridged room — which a war room under this SOP is —
**anything the room must not miss goes at the root**. That is not a Switch limitation to work around; it is a rule for
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

**Switch cannot.** There is no scheduling primitive exposed to a room or an
agent: no cron, no timers, no deferred actions, nothing an agent can ask to be
woken by. Switch does run periodic work internally — connection and
runtime-state sweeps at boot, bridge-level renewal loops, `call_later` timers
that batch attachments — but none of it is reachable from a room, and none of it
is scheduling in the sense the SOP means.

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
  `description`, `default` and — for `enum` — the list of permitted values.
  There is no `required:` key: a parameter is required exactly when it has no
  default.
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
- **`bridge:` is a required parameter and not omitted.** The comment on the
  template's own `bridge` field says to omit it for an internal-only room, and
  that is wrong: omitting it falls through to the instance default bridge — or,
  with no default configured, to no bridge at all, and with a default configured
  but not running, to a hard failure. Worse, the guard that rejects `users:` on
  an unbridged room tests the template's resolved bridge id, so a template with
  `users:` and no `bridge:` is rejected even though the room would in fact have
  been bridged. Naming the bridge explicitly sidesteps all of it.
  [Gaps](#gaps) G10.
- **The `scribe` role is defined but nobody is told to take it.** See
  [Roles are the wrong tool for the on-call rotation](#roles-are-the-wrong-tool-for-the-on-call-rotation)
  — a role is held per *agent*, globally, so the shared responder can hold it in
  one incident at a time. It is there for a responder's own coding agent to
  assume, and the template does not assume it on anyone's behalf.
- **`write_visibility: private`, and this is the one to argue about.** Public
  write on a room does not mean "participants may restructure it" — it grants
  write to *any* principal in the tenant, member or not, and write on a room is
  what governs attaching a reference, defining and deleting roles, updating the
  room and archiving it. A war room that any agent's owner in the deployment can
  archive mid-incident is not a trade worth making, so this template narrows it:
  readable by everyone, restructured only by the room's owner and admins.

  The cost is real but small. Attaching a reference mid-incident becomes the
  instantiating user's job. Adding agents and users is *not* affected — the
  roster path is governed separately and admits existing members regardless of
  visibility — so pulling another agent into the war room still works for anyone
  already in it, which is the operation that actually matters under pressure.

This document is not illustrative. It was run through the shipped parser —
`ParamSpec`, `resolve_params`, `interpolate`, `RoomSpec`, and the visibility-pair
validator — with the inputs below, and it resolves: `visibility` defaults to
`channel_public`, the `public` / `private` visibility pair is accepted, every
placeholder substitutes with none left over anywhere including inside the seeded
documents, the room comes out named `flint incident 1287`, and the Slack channel
it would create is `flint-incident-1287`. Anything in this section that turns out
to be wrong is a bug in the design, not a typo in the YAML.

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

### What a template still cannot set — and why that is the real finding

Measured against what a room can hold, the merged template reaches
`name`, `description`, `instructions`, `bridge`, `channel_type`, the two
visibilities, `agents`, `users`, `roles`, `references` and `docs`. It cannot
reach:

| Cannot set from a template | Why it matters here | Reachable another way? |
| --- | --- | --- |
| `aliases` | No `@responder` handle; responders must know the agent's real name. | **Yes** — `create_room`, `update_room`, `PATCH`, or `!set-alias` in the room. |
| `linked_rooms` | The war room cannot point at the alert hub, the stakeholder channel or the postmortem room. | **Yes** — `create_room`, or `link_rooms` after. |
| `group_id` | Incidents cannot be filed under a product's group. | **Yes** — `group_name` on `create_room`. |
| `join_event_listeners` | Without it the responder never learns that someone joined, so it cannot greet an arrival and tell them the state. | **Yes** — `create_room` or `update_room`. |
| `internal_only` | Not needed here — war rooms are bridged. | Yes, on `create_room`. |
| `package_ids` | No packaged tooling attached at creation. | Yes, on `create_room`. |
| room metadata | Nowhere structured to record severity or the incident id; both live in prose. | No. |

That last column is the finding, and it is more useful than the list itself:
**a room template is strictly less capable than the room creation it wraps.**
Every one of those fields is already accepted by `create_room` — the HTTP
endpoint, and the agent operation of the same name — and most can be set
afterwards with `update_room`. The template format simply does not carry them.

Two consequences worth acting on:

- **The gap is a format gap, not a platform gap**, so it is cheap. Nothing needs
  designing; the provisioner needs to pass through fields the config object
  already has.
- **Until it closes, an agent that creates the war room by calling `create_room`
  directly can do everything the template can and more** — aliases, links, the
  group, and join events included. That is a genuine fork in the road: the
  template is the reusable, reviewable, version-controlled artifact, and
  `create_room` is the capable one. Choosing the template means accepting a
  follow-up call to set what it could not, or accepting that the war room has no
  `@responder` alias and cannot greet arrivals.

The greeting is the one worth wanting. A war room's worst recurring moment is the
fourth person arriving twenty minutes in and asking "what's the state?" — a
question the responder could answer the instant they join, if something opted it
into join events. A template cannot; one extra `update_room` call can.

## The responder agent

The rotation is the whole problem. Six engineers take the pager in turn; the
agent has to be the same agent for all of them, reachable by whoever is on duty,
and not degraded by the fact that the person who set it up is on holiday.

### What the SOP needs it to do

Modest, deliberately. In the war room:

- **Answer lookups.** Who owns this service. What the runbook says. What the
  escalation ladder is. These are the questions that cost minutes at 03:00 and
  they are all document reads.
- **Draft the situation report** in the right shape when nudged, from what the
  room has said, for a human to check and post onward.
- **Keep the timeline**, so the postmortem is written from a record rather than
  from memory.
- **Orient arrivals** — say what is known so far when someone joins.

Note what is absent: it does not page, does not set severity, does not decide,
and does not act on production. The SOP grants *humans* the authority to roll
back and to push emergency fixes; extending that to a shared agent that six
people can address and nobody can attribute would be the single worst decision
available here. See [The rule that makes it safe](#the-rule-that-makes-it-safe).

### What `flint-tracker` actually is

Read from the live instance rather than assumed, because it is the prior art and
being wrong about it would poison the recommendation:

- **Name: `flint-tracker`.** No owner suffix. Every other Claude Code agent on
  the instance registered through Switch Console carries one —
  `claude-code.<project>.<person>`. This one reads as a service, and that is not
  cosmetic: the name is the routing key for everything. Mentions, the Slack user
  group the bridge mints, room aliases and `target_names` all resolve `name`,
  and `display_name` routes nothing at all.
- **Owner: the deployment's `Admin` account.** Not a person.
- **`connection_model: auto_session`, `channels_enabled: true`**, with a working
  directory on a shared always-on host rather than on anyone's laptop. Something
  runs there continuously, watching for the agent to be addressed and spawning a
  session on demand.
- **`addressing_policy: null`** — wide open. Anyone in any room it is in can
  address it.
- **Six room memberships across three platforms** — Slack, Discord and
  Mattermost. It is designed to be invited around, not to live in one room.
- **A description written at the reader**, ending "Invite it into any room and
  ask what was decided, what changed, or who owns something." It tells a
  stranger what to do with it.

That is a coherent design and most of it is exactly right for a responder.

### What carries over

**The name.** `flint-responder`, not `claude-code.oncall.<someone>`. It is the
handle six people will type under pressure and it must not encode whose agent it
is.

**Shared infrastructure, not a laptop.** This is the load-bearing one. An
`auto_session` agent is brought online by a watcher process; put that watcher on
an always-on host and the agent is online regardless of who is on duty, whether
their machine is asleep, or whether they have ever installed Switch Console.
A responder that only works when a particular laptop is open is not a responder.

**An open addressing policy.** A rotating group cannot be enumerated, so the
policy cannot enumerate it. Open within the rooms it is in is the correct
setting, and it is what `flint-tracker` runs.

**Membership by invitation.** The agent belongs to rooms, not to a room. A war
room is created and the agent is added; nothing about the agent changes per
incident.

**A description that tells a stranger what to ask.** Half the value of a war-room
agent is discovered by someone who has never used it, mid-incident, from the
member list.

### What breaks

Six things, in rough order of how much they will hurt.

**1. Admin ownership hands the agent the whole deployment.** An agent inherits
*exactly* its owner's permissions — the authorization module says so in its
opening lines — and `User.role == "admin"` is a global bypass on every read,
write and delete. So an Admin-owned agent can modify or delete any reference,
document, package or room in the tenant. For an agent that reads Slack and
summarises, that is an over-grant you can live with. For a responder that runs
during an incident, with tool access, addressed by six people under time
pressure, it is not: the moment its blast radius is widest is exactly the moment
it is unbounded. **Do not copy this part.**

**2. There is nothing good to own it instead.** Switch has exactly one
shared-owner construct: the synthetic bootstrap account that owns every agent
registered with the deployment-wide token. It is deliberately non-admin, which is
right. It is also password-less, so on a password deployment nobody can sign in
as it. (On an OIDC deployment this is softer than it sounds — an identity
provider that asserts that address would link to the existing account — but that
is a deployment accident, not a supported way to hold a shared identity.)

The consequence is narrower than "unmanageable" and still bad. An admin *can*
manage a bootstrap-owned agent: edit its options, set its addressing policy,
delete it. What nobody can do is **reveal its credential**, because credential
reveal is the one check in the system with strict owner equality and no admin
bypass. So a bootstrap-owned responder is an agent whose token can never be
recovered — you can rotate it by re-registering, and you can never read it.

So the correct answer, "own it with a non-person account that is not an admin",
needs a service user someone can actually authenticate as, and there is no
supported way to make one. [Gaps](#gaps) G11.

Note also that "user-agnostic" cannot mean *ownerless*. An agent with
`owner_id IS NULL` cannot create a reference, attach one, list references, or
attach resources when creating a room — every one of those paths resolves the
agent to its owner and fails loudly without one. It cannot even edit itself over
MCP, because that guard compares two `None`s and refuses. Ownerless is a broken
agent, not a neutral one. **User-agnostic means owned by a non-person, not owned
by nobody.**

And ownership is permanent: `owner_id` is set at registration and there is no
endpoint anywhere that changes it. Registering the responder under a person "just
for now" means it is theirs until someone runs an `UPDATE`.

**3. The default addressing policy locks the rotation out, and the UI that fixes
it breaks it.** Every agent registered through any HTTP path is created
owner-only with an empty allowed-agents list. The `register_agent` function takes
an `owner_only=False` parameter, but no wire path passes it — the sole caller is
the server-side connector registration, whose comment is worth quoting because it
is this design's precedent:

> A server-side connector agent is a service the deployment offers everyone, not
> one person's assistant; it is owned by whoever holds the registration token
> only in the bookkeeping sense. Owner-only would make it answer to that account
> alone.

So the responder is born locked and must be widened afterwards through
`PUT /agents/{id}/addressing-policy`. And here is the landmine: the gateway's
React policy editor models only the four id-shaped dimensions, so the symbolic
`owner` and `owner_agents` rules are dropped from any rule it saves.

The dashboard does catch the worst case — a rule with every sender dimension
empty is flagged "This rule can never match" and Save is disabled — so you
cannot brick the agent outright. What you *can* do is the ordinary thing: open
the default owner-only policy, add an agent to the allowed list, save, and
silently lose `owner: true` in the process. The policy that comes back admits
that one agent and locks out the human owner, who then gets

> You're not permitted to direct messages to me in this room — my operator has
> restricted who can address me here.

from their own agent. Mid-incident that reads as an outage. Switch Console's
editor round-trips the symbolic rules correctly; the gateway's does not.
[Gaps](#gaps) G12.

**4. The offline nudge wakes the wrong person.** When an `auto_session` agent is
addressed in a room where nothing can start it, Switch posts on its behalf. The
message names the *owner*:

> `@owner` — I'm not online in this room, and `@asker` needs me. Open Switch
> Console to bring me online here.

and, when the owner has no account on that platform to mention:

> I'm not online in this room, and `@asker` needs me. **My owner needs to open
> Switch Console** to bring me online here.

Both may carry a terminal command underneath.

The code's own comment explains the reasoning — "the fix is for the OWNER to open
it, and nobody else in the room can act" — which is sound for a personal agent
and exactly wrong for a shared one. At 03:00 the war room will either name a
service account nobody watches, or a dead end. What it should name is whoever is
on call. [Gaps](#gaps) G13.

Running the watcher on an always-on host makes this rare rather than fixing it.

**5. One credential, no rotation, no per-holder revocation.** One agent has
exactly one API key row. There is no rotation endpoint: the only way to change
the key is re-registration with overwrite, which deletes the old row, so every
holder breaks at once. Reveal is restricted to the owning user with no admin
bypass. And the token is a bearer credential in a plaintext file in the agent's
working directory — the repository's own documentation calls that a known
exposure.

The practical consequence is a rule rather than a fix: **the responder's
credential lives in exactly one place, on the shared host, and is never
distributed to responders.** Handing it to six laptops means six copies of a
token nobody can individually revoke, on machines that leave with their owners.
[Gaps](#gaps) G14.

This also settles a mechanical question. Two people *can* run sessions as the
same agent — identity is per directory, not per machine, and an agent may hold up
to 32 connections. But at most one session of an agent may act in a given room,
and `connect_to_room` always takes over: the newcomer wins and is warned what it
displaced, and the incumbent stops receiving that room's events. The incumbent's
notification is a bare subscription change with no reason attached, so in
practice one responder's session goes quiet without explaining why. Two
responders each starting a session during one incident would evict each other in
turn. One process, on one host, is the only sane operating mode.

**6. Nothing records which human drove it.** No actor is stored on connections,
sessions, runtime state, role leases or messages; a message is attributed to the
agent, not to whoever prompted it. For most agents that is a shrug. For incident
response it is not, because the postmortem's second question is always "who did
what, when". [Gaps](#gaps) G15.

There is a mitigation, and it is a design rule rather than a feature — see below.

### Roles are the wrong tool for the on-call rotation

Room roles look purpose-built for this: named, assumable instruction bundles;
`@role` reaches whoever currently holds it; an exclusive role admits one holder
and auto-releases about six seconds after that holder dies. "Address whoever is
currently the incident commander" is precisely the sentence roles exist for.

They still do not work here, for three reasons.

**A lease is held per agent, globally.** The lease table is unique on the agent,
not on the session and not on the room. One shared responder can therefore hold
one role, in one room, across the entire instance. Two concurrent incidents and
it can be the scribe in only one of them. Worse, two sessions of the same agent
assuming the same role is treated as an idempotent re-assume — the second simply
overwrites the first's session pointer — so roles provide no arbitration at all
between two people running the shared agent, which is the one thing you might
have hoped they would provide. [Gaps](#gaps) G16.

**Humans cannot hold roles.** Assuming a role is an agent operation. The incident
commander is a person, so the role cannot be theirs.

**There is no eligibility control.** The role model carries an `eligibility`
field that is declared, documented as a forward-looking hook, and read by
nothing. Any room member may assume any role. "Only the on-call primary may take
incident commander" is not expressible. [Gaps](#gaps) G17.

Where roles *do* work is between distinct agents. If responders bring their own
coding agents into the war room — which they will, because that is how anyone
investigates — then an exclusive `scribe` role is genuinely good: one holder at a
time, real handoff by release-and-assume, automatic release within seconds if
that engineer's session dies. That is why the template defines the role and
assigns it to nobody.

So: **incident commander and scribe stay human conventions, written in the room's
instructions. The `scribe` role exists for a responder's own agent to pick up,
not for the shared responder.**

### The recommendation

**One shared responder agent per product, owned by a dedicated non-admin service
user, running `auto_session` on shared always-on infrastructure, with an open
addressing policy, invited into each war room by the template, and never run from
an engineer's machine.**

Concretely, on top of what `flint-tracker` already gets right:

| Setting | Value | Why |
| --- | --- | --- |
| `name` | `<product>-responder` | The routing key. No person in it. |
| owner | a dedicated service user, **not** an admin | The agent inherits its owner's permissions exactly. |
| `connection_model` | `auto_session` | Comes online when addressed; nobody has to remember to start it. |
| watcher | one, on an always-on host | Online regardless of whose turn it is. |
| credential | one copy, on that host | Cannot be revoked per holder, so do not spread it. |
| addressing policy | open | A rotation cannot be enumerated. |
| room membership | per incident, via the template | Nothing about the agent changes per incident. |
| roles held | none | A lease is per agent; holding one breaks the second concurrent incident. |

Two alternatives, and why not:

- **One responder agent per engineer.** Real per-human attribution, real role
  arbitration, and each agent already exists in some form. But it is six
  registrations, six addressing policies and six credentials to keep consistent,
  it churns on every rotation change, and each agent is still personally owned —
  so the day someone leaves, their responder leaves with them. It solves
  attribution by giving up shared identity, which is the thing that was asked
  for.
- **Own the shared agent with the Admin account, like `flint-tracker`.** One
  fewer problem today, in exchange for an agent with unbounded authority over
  every room and resource in the deployment, addressable by anyone, during the
  worst hour of the quarter. If G11 cannot be closed before the first incident,
  this is the compromise to take *knowingly and temporarily* — and the mitigation
  is that the agent has no production access and no write path outside its rooms.

### The rule that makes it safe

Because nothing records which human drove the agent, the room transcript has to
carry the attribution instead. That is achievable, but only if the agent is
constrained:

> **The responder takes no consequential action that a human did not ask for, in
> the room, in writing.** Everything it does is either a read, or a draft posted
> back to the room for a human to act on. It never posts to the stakeholder
> channel, never touches the incident record, and never runs anything against
> production.

Under that rule the room *is* the audit log: every action the agent took has a
message above it from the person who asked. Relax the rule and the attribution
hole in G15 becomes a real one. The rule belongs in the room instructions, where
the template puts it, and in the agent's own configuration.

## Gaps

Eighteen, grouped by what they block. Each names what is missing, why it matters
for this SOP specifically, and a ticket to file. Sizes are rough: **S** is days,
**M** is a sprint, **L** is a project.

Read G1 first. It is the one the SOP itself has flagged and nobody has answered.

### A. Knowing who is on call

**G1 — Switch has no concept of duty, and cannot learn one.**
There is no rotation, schedule, team or on-call anything in the codebase. The
tenant membership role field exists but is documented as recording a value that
nothing yet reads. The SOP's own comment thread asks "how will Switch pull in
who's on-call from PagerDuty?" and answers itself with the right idea — a mention
group whose membership auto-rotates. Switch cannot consume that either:
`add_users_to_room` resolves individual usernames against the people the bridge
has already seen, and there is no call anywhere that expands a Slack user group
into its members. Note the asymmetry — Switch *creates* a Slack user group per
agent, so `@<agent>` works, but it never sets that group's membership and cannot
read anyone else's.

Until this is closed, "invite the on-call engineers" is a human action, and the
template's invitee list is hard-coded or empty.

> **Proposed ticket:** *Resolve a platform group to room members* — accept a
> bridge group handle wherever `user_names` is accepted, expand it through the
> platform (Slack user groups, Discord roles, Mattermost groups) at the moment
> of use, and add the members. Deliberately no schedule in Switch: the rotation
> stays in PagerDuty, which syncs the group. **M**

> **Proposed follow-up:** *Room escalation target* — a room-level setting naming
> who to reach when an agent cannot be brought online or nobody has responded,
> resolvable to a group. Feeds G13. **S**

### B. Making the template usable

**G2 — The registry cannot instantiate what it stores.**
`POST /rooms/from-yaml` provisions from a document in the request body. The
registry stores documents. Nothing joins them: there is no "instantiate template
`<id>` with these inputs". Using a registered template today means fetching its
content and posting it back, which makes the registry a filing cabinet rather
than a feature.

> **Proposed ticket:** *Instantiate a stored template by id* —
> `POST /templates/{id}/instantiate` taking `inputs`, resolving the stored
> content and provisioning through the existing path. **S**

**G3 — The dashboard cannot supply parameter inputs.**
The create-from-YAML page posts raw YAML with no `inputs` field, so from the UI
only a template whose every parameter has a default can be used. A template
built for per-incident particulars has no useful defaults. Parameters are
therefore reachable only from an API client — which, for a feature whose whole
point is that a human instantiates it, is the same as unreachable.

One caveat to check before acting on this: the template linter's own comments
refer to "a document the Console wizard renders happily", implying a client that
does collect inputs. Nothing under `console/` on this branch posts to
`/rooms/from-yaml` or renders a `params:` block, so either that wizard is
unmerged or it lives somewhere this tree cannot see. If it ships, this gap
narrows to "the gateway cannot", which is much less serious.

> **Proposed ticket:** *Parameter form for template instantiation* — render the
> declared `params:` as a form (using `description`, which is currently stored
> and never displayed), collect values, post the JSON body form. **S**

**G4 — A parameter cannot hold a list.**
`ParamSpec.type` is `string`, `number`, `boolean` or `enum`. A room's `agents:`
and `users:` are lists, so a variable-length membership cannot be parameterised
at all: `"alice,bob"` interpolates into one entry. In `users:` that entry
silently resolves to nobody and is reported as unresolved; in `agents:` it is a
hard `Unknown agents:` failure that aborts provisioning. For an incident template
whose responders differ every time, this is the difference between a template
that works and one that has to be edited before each use.

> **Proposed ticket:** *List-typed template parameters* — add a `list` parameter
> type whose whole-field substitution splices into the surrounding list rather
> than stringifying. **M**

**G9 — A room template is strictly less capable than the room creation it wraps.**
`RoomCreateConfig` carries `aliases`, `linked_rooms`, `group_id`, `package_ids`
and `join_event_listeners`, and `create_room` accepts every one of them. The
template provisioner populates none. The first three arrive with group templates;
`join_event_listeners` arrives nowhere. Nothing here needs designing — the fields
already exist on the config object and are already validated — so this is a
pass-through, not a feature.

> **Proposed ticket:** *Land group templates* — merge
> `origin/work/group-templates`: `group:`/`rooms:`/`links:`, per-room `aliases:`,
> and dict-key interpolation. **M**

> **Proposed ticket:** *`join_event_listeners` in a room template* — a per-agent
> opt-in in the room spec. **S**

**G10 — Omitting `bridge:` silently means "the default bridge", and breaks
`users:`.**
The comment on the template's `bridge` field says to omit it for an internal-only
room. That is wrong: omitting it falls through to the instance default bridge —
and, less obviously, to no bridge when there is no default, or to a hard failure
when the default is configured but not running. (The `internal_only` field's own
documentation is accurate and says exactly this; the misleading comment is on the
template side.) Compounding it, the guard that rejects `users:` on an unbridged
room tests the template's own resolved bridge id, so a template with `users:` and
no `bridge:` is refused even though the room would have been bridged.

> **Proposed ticket:** *Fix `bridge:` omission semantics in a room template* —
> resolve the default bridge before the `users:` guard, and add an explicit
> `internal_only:` key so "no channel" is stated rather than inferred. **S**

**G-trap — a mistyped placeholder ships.**
Not a gap so much as a hazard worth writing down: a `{word}` that no parameter
declares is left verbatim, on purpose, so JSON braces in document content
survive. A typo in a placeholder name therefore does not error — it appears in
the created room. The linter catches some of this; the registry blocks only three
findings and treats the rest as advice. Lint before registering, and read the
output.

### C. Getting the room made at all

**G5 — No agent can instantiate a template, and no one can from a channel.**
The agent operation surface has 46 operations and not one of them touches
templates. The in-room command set has 21 and not one creates a room.

Be precise about what this does and does not mean. An agent *can* open a war room
— `create_room` is an agent operation and takes agents, users, roles, references,
links, a group, aliases and join listeners. What it cannot do is open the room
*from the reviewed, version-controlled template*, which is the whole point of
having one. And an on-call engineer in the alert channel cannot declare an
incident from the channel they are already in; they have to leave Slack for an
API client or the dashboard, at the moment they least want to.

> **Proposed ticket:** *`create_room_from_yaml` agent operation* — land the
> operation already written on `origin/work/group-templates`, extended to take a
> template id (needs G2). **S**

> **Proposed ticket:** *`!declare-incident` in-room command* — instantiate a
> configured template from a bridged channel with positional inputs, and post
> the new room's link back. **M**

**G6 — There is no generic alert ingress.**
Switch does listen for inbound HTTP from a platform — the Teams bridge runs its
own endpoint and verifies the caller's signed token against the published keys,
so the machinery for authenticating an inbound webhook exists and is proven.
What does not exist is anything generic: no endpoint that accepts a third-party
alert payload and maps it to a Switch action. So the SOP's promise — "Switch will
auto-create a dedicated channel on declaration" — cannot be kept by Switch alone;
something outside has to hold a credential and call the API. That is workable and
probably correct for a first version, but it should be a decision rather than a
discovery.

> **Proposed ticket:** *Incident intake webhook* — a signed inbound endpoint that
> maps an alerting payload to a template instantiation, with the field mapping
> configured per source. Depends on G2. **L**

**G7 — There is no scheduling primitive a room or an agent can use.**
Switch runs periodic work internally — sweeps, renewals, batching timers — but
none of it is reachable from a room, and an agent cannot ask to be woken. The
SOP's hourly and four-hourly update cadence therefore lives in an external
scheduled workflow that mentions the agent — which works, and is the right
short-term answer, but has to be created per incident and nobody will remember to
delete it.

> **Proposed ticket:** *Scheduled room actions* — a room-scoped recurring
> trigger that posts a message or addresses an agent, created with the room and
> disposed of with it. **L**

**G8 — There is no relay between rooms.**
Linked rooms are metadata: a pointer with a label. There is no mechanism that
mirrors a message from one room into another. The SOP wants situation reports to
land in both the alert channel and the stakeholder channel, and the source
document asks directly whether that can be automated. Today an agent can read
another room without connecting to it, but posting requires connecting, which
means leaving the war room mid-incident. That is not a workaround anyone should
adopt.

> **Proposed ticket:** *Mirror a message to a linked room* — an operation that
> posts to a room the agent is a member of without moving its connection,
> attributed and marked as a mirror. **M**

### D. The shared agent

**G11 — There is no provisionable service account.**
The recommendation in this document rests on owning the responder with a
non-person, non-admin user. Switch has exactly one shared-owner construct — the
synthetic bootstrap account — and on a password deployment nobody can sign in as
it. An admin can still *manage* its agents; what nobody can do is reveal their
credentials, because credential reveal is the one check with strict owner
equality and no admin bypass. The alternatives are to own the responder with a
real person (defeats the purpose) or with the Admin account (hands it a global
bypass over every room and resource in the tenant). **This is the gap the whole
responder design depends on.**

> **Proposed ticket:** *Service accounts* — a non-interactive user that can own
> agents and resources, with authentication a team can hold jointly, and no
> admin role. **M**

> **Proposed ticket:** *Transfer agent ownership* — an owner-or-admin endpoint
> setting `owner_id`. There is none today, so an agent registered under the wrong
> account stays there. **S**

**G12 — The gateway's addressing-policy editor silently deletes owner rules.**
The React editor models only the four id-shaped dimensions and drops the symbolic
`owner` / `owner_agents` rules from any rule it saves. It does guard the extreme
case — an all-empty rule is flagged as unmatchable and Save is disabled — so the
agent cannot be bricked outright. The reachable damage is quieter: widening the
default owner-only policy by adding an allowed agent saves a policy that admits
that agent and no longer admits the owner. Switch Console's editor round-trips
the symbolic rules correctly. This is a live bug, and it sits directly on the
path of anyone widening a shared responder's policy.

> **Proposed ticket:** *Preserve symbolic rules in the gateway policy editor* —
> represent `owner` and `owner_agents`, round-trip them, and warn when a saved
> policy admits nobody. **S**

**G13 — The offline nudge names the owner, not whoever can act.**
When an `auto_session` agent is addressed with nothing to start it, the room is
told to go and wake the owner. For a shared responder that is a service account
nobody watches, or a person who is not on call. The wording is right for a
personal agent and wrong for a shared one, and there is no way to override it.

> **Proposed ticket:** *Escalation target for an offline shared agent* — when an
> agent has no personal owner, address the nudge to the room's escalation target
> (see G1's follow-up) instead of to `owner_id`. **S**

**G14 — One credential per agent; no rotation, no per-holder revocation.**
One agent, one API key row. No rotation endpoint — the only rotation is
re-registration with overwrite, which breaks every holder simultaneously. Reveal
is strict owner equality with no admin bypass. A shared agent therefore has a
credential that cannot be issued per person, cannot be revoked per person, and
cannot be recovered by anyone but its owner.

> **Proposed ticket:** *Per-holder agent credentials* — several named,
> independently revocable keys per agent, each attributable, with a rotation
> endpoint that does not break the others. **M**

**G15 — Nothing records which human drove a session.**
No actor field on connections, sessions, runtime state, leases or messages. A
shared agent's actions are attributable to the agent and to nobody else. The
mitigation in this design is the rule that the agent acts only on a written
request in the room — which makes the transcript the audit log — but that is a
convention, and conventions are not enforcement.

> **Proposed ticket:** *Record the operator behind a session* — capture an actor
> on session registration and carry it onto messages the session sends. **M**

**G16 — A role lease is held per agent, globally.**
Unique on the agent, not on the room and not on the session. One agent can hold
one role across the whole instance, so a shared agent in two concurrent incidents
can be the scribe in only one. And two sessions of the same agent assuming the
same role is an idempotent re-assume, so roles arbitrate nothing between them.

> **Proposed ticket:** *Scope a role lease to (agent, room)* — allow one agent to
> hold a role in each of several rooms, and decide explicitly what two sessions
> of one agent assuming one role should mean. **M**

**G17 — Role eligibility is declared and unused; humans cannot hold roles.**
`RoomRole.eligibility` exists, is documented as a forward-looking hook, and is
read by nothing — any room member may assume any role. And roles are assumable
only by agents, so "incident commander" cannot be a role at all.

> **Proposed ticket:** *Enforce role eligibility* — implement the declared field
> so a role can be restricted. **S**

> **Proposed ticket:** *Human-holdable roles* — let a person claim a room role
> from the bridged channel, so `@incident-commander` reaches a human. **L**

### E. Closing the incident out

**G18 — There is no transcript export.**
The postmortem is written from the room, but there is no endpoint that produces a
room's history: the gateway exposes a room's *configuration* as YAML and nothing
else, and reading messages is an agent-only operation. In practice the responder
agent can page back through the room and post a timeline as an attachment, which
is good enough — so this is the cheapest gap on the list and the least urgent.

> **Proposed ticket:** *Export a room transcript* — a downloadable, paginated
> history export for a room a user can read. **S**

## What to build first

Nothing on that list blocks a first incident. Two things are worth being explicit
about:

**Usable on day one, with no Switch change at all.** Write the template, register
it, and have one person instantiate it through the API when an incident is
declared, pasting the incident's particulars as inputs. Invite responders by
hand. Put the update cadence in a scheduled Slack workflow that mentions the
responder. Register the responder agent, widen its addressing policy through the
API — not the dashboard, see G12 — and run its watcher on an always-on host. That
is a working SOP on Switch, with two manual steps.

**The order to remove the manual steps in**, by value per unit of work:

1. **G2 + G3 — instantiate a stored template, with a form.** Two small changes
   that together turn the registry from a filing cabinet into the feature. Until
   these land, every other template improvement is invisible to the people who
   would use it. Start here.
2. **G11 — a service account.** Small in scope, and the recommendation for the
   responder agent is unsound without it. Every day it is missing is a day the
   responder is either one person's agent or an admin.
3. **G12 — the policy editor bug.** A few hours' work, and it will otherwise be
   discovered by someone widening the responder's policy during an incident.
4. **G1 — resolve a platform group to room members.** The largest single
   reduction in manual work: it turns "invite the on-call engineers" from a
   human step into a template line, and it is the question the SOP has been
   asking. Deliberately without building a rotation in Switch.
5. **G5 — declare an incident from the channel.** Once the template instantiates
   cleanly, letting an engineer trigger it from Slack removes the last manual
   step in the critical path.
6. **G9 — group templates, and join-event listeners.** The postmortem room, the
   links, the `@responder` alias, and the ability to greet an arrival. All
   quality, none of it blocking.
7. Everything else, as it starts to hurt.

The honest summary: **Switch can host this SOP today, badly, with two manual
steps and one unsafe compromise on agent ownership. Items 1 to 3 make it
respectable, and they are small. Item 4 is the one the team actually asked for.**
