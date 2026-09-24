# Incident response on Switch

How an on-call and incident-response SOP runs on Switch. The pieces:

- the product's alert channel, adopted as a standing hub;
- a shared responder agent that pings on-call when an alert needs triage, and
  builds a war room when a Sev0 is declared;
- a registered room template that the agent fills in;
- PagerDuty, reached the same way Jira already is.

This is a design, not an implementation. Nothing here has been built. Where
Switch cannot do what the SOP needs, the gap is named and a ticket proposed
rather than designed around. If you read only one section, read
[Gaps](#gaps).

Written against `main` at `514d5ba4`, and re-checked at `f4ada844` for
everything the SOP's current version depends on:

- how room events reach an agent;
- how Slack mentions are translated in each direction;
- how a role mention is routed;
- the template format and `create_room_from_yaml`.

The hosting, ownership and credential claims were checked at `514d5ba4`.
Every claim about how Switch behaves was checked against the code rather than
recalled. Where a behaviour is surprising enough to be worth confirming, the
file it lives in is named.

**The configuration is in a companion document,**
[`incident-response-instructions.md`](incident-response-instructions.md): every
block of instruction text, labelled with the field it goes in, the war-room
template, and a step-by-step deploy guide. This document is the argument; that
one is the configuration.

- [Scope](#scope)
- [The SOP, and the two places Switch appears in it](#the-sop-and-the-two-places-switch-appears-in-it)
- [Mapping the SOP onto rooms](#mapping-the-sop-onto-rooms)
- [Watching the alert hub](#watching-the-alert-hub)
- [The incident-response agent](#the-incident-response-agent)
- [The war-room template](#the-war-room-template)
- [Reaching PagerDuty](#reaching-pagerduty)
- [Where the agent runs](#where-the-agent-runs)
- [Making the agent user-agnostic](#making-the-agent-user-agnostic)
- [Gaps](#gaps)
- [What to build first](#what-to-build-first)

## Scope

The subject is a specific SOP: a lightweight, post-launch, business-hours
rotation. It alerts on-call with a Slack mention and coordinates in Slack. It
is deliberately temporary: its own text says it will be replaced once a 24/7
rotation and real tooling exist. So the design optimises for reuse and
disposal: a shape a team can stand up per product and throw away, not a
standing structure to maintain.

The SOP belongs to one product team, and this document does not reproduce it.
The team's channel names, on-call handles and service owners are
configuration, not content. They live in one bindings block, supplied per
product. That keeps this design reusable across products, and keeps a public
repository free of one team's internal routing.

**Out of scope.** Configuring the PagerDuty or Datadog products themselves,
beyond the one line each needs; Switch Console's side of any of this; anything
that needs code to exist before it can be described. Where the SOP depends on
such a thing, it appears in [Gaps](#gaps).

## The SOP, and the two places Switch appears in it

The flow, compressed, as the SOP's current version has it:

1. An alert fires and lands in the product's alert channel.
2. **The responder agent sees a risky alert and mentions the on-call handle in
   Slack: "this needs triaging."** A Slack mention, not a page. No phone
   buzzes.
3. On-call triages against logs, dashboards and runbooks, and answers the one
   question that matters: **is a customer affected?** No means a routine
   alert: resolved in PagerDuty with notes, and nothing else happens. Yes
   means a customer incident.
4. On-call declares it by setting the priority in PagerDuty, and **the
   declaration is what triggers coordination.**
   - At Sev0: the incident is logged in PagerDuty as
     `[Feature] [Severity] [Symptom]`, **Switch creates a dedicated channel and
     invites the on-call engineers to it**, and a video call is opened.
   - At Sev1 there is no war room. On-call works from the runbooks and
     escalates to the service owner if stuck for an hour.
5. Updates go out on a clock: hourly at Sev0, every four hours at Sev1,
   **until the issue is mitigated**. Each is a five-field situation report,
   posted to both the alert channel and the stakeholder channel.
6. Recovery is confirmed and the incident resolved in PagerDuty. The RCA is
   written in the team's template, and for Sev0 an RCA meeting is held within
   five business days.

Switch now appears at two points; the earlier draft had one. Step 4 is the
one it always had:

> Switch will auto-create a dedicated Slack channel and switch will invite
> on-call engineers to war-room.

Step 2 is new, and it changes the agent's *position* more than its workload.
In the earlier draft PagerDuty paged the on-call directly, and the agent
arrived only after a person declared. Now the agent is **how on-call learns of
an alert.** Its availability has moved onto the alerting path; see
[The agent is on the alerting path](#the-agent-is-on-the-alerting-path).

The rest is still not Switch's. Severity, the resolve and the incident record
are PagerDuty's. Diagnosis is Datadog's and the runbooks'. **The SOP does not
need Switch to run incident response.** It needs Switch to put the right
alert in front of the right person with the right context, and, after a
declaration, to produce a correctly-shaped, correctly-populated room within
seconds and then be useful inside it. A design that moves severity, paging or
the incident record into Switch would be building a competitor to PagerDuty
that nobody asked for.

What Switch adds is not the ping or the channel; Slack can do both. It is that
each arrives already furnished. The ping names the service's owner, its Sev1
threshold and its runbook. The room arrives with the SOP attached, the
situation-report shape attached, the right people already invited, and a
responder already in it, briefed on which service is broken and how badly. A
person doing that by hand at 03:00 does it badly or not at all.

### What changed from the earlier draft

This design was first written against an earlier draft of the SOP. The
current version changes it in these places:

- **Paging and acknowledgement are gone.** PagerDuty no longer pages the
  on-call; the agent mentions their Slack handle. The earlier draft's "no
  leadership tier on the page" rule goes with them.
- **The agent is named.** The team is reusing a shared agent it already runs,
  rather than standing up a dedicated one. See
  [The agent the team chose](#the-agent-the-team-chose).
- **The war room invites the on-call engineers,** and the earlier list of
  standing invitees (service owner, stream lead, support) is gone.
- **The postmortem has a template**: the team's own RCA page. The skeleton
  this design used to propose is gone with it.
- **Four sections are not in the current version:** the escalation ladder, the
  on-call's authority to act (including the emergency deploy), the on-call
  checklist, and the war-room invitee list. Where this design relied on them,
  it now says the SOP does not cover the point, rather than carrying the old
  text forward. The rule that no agent touches production stays, because it
  is this design's rule, not the SOP's.

### The questions the SOP has not answered

The earlier draft carried open review comments, and three were load-bearing:

- **"How will Switch pull in who's on-call from PagerDuty?"** It has a clean
  answer; see [Reaching PagerDuty](#reaching-pagerduty). The current version
  makes it smaller still: the ping goes to a Slack handle, and the invitees
  include whoever answered in the alert's thread.
- **"Can we automate mirroring updates from the alert channel into the
  stakeholder channel?"** Two rooms, one message, no relay. [Gaps](#gaps) G8.
- **"A scheduled Slack workflow could mention the Switch agent to kick off
  updates."** Superseded by the agent's own poll; see
  [Cadence](#cadence-and-the-thing-that-nudges). A scheduled workflow survives
  as the start-of-shift check.

The current version adds four more, all listed for the team to decide in the
deploy guide's Phase 1:

- what makes an alert "risky";
- what happens when both regions are in hours, and when neither is;
- which on-call engineers are invited to a war room;
- what the escalation rule is at Sev0 (only Sev1's is stated).

## Mapping the SOP onto rooms

Switch has one structural primitive that matters here, the room, plus threads
inside it and links between rooms. Getting the mapping right is mostly a
matter of refusing to over-model.

### What is a room

**Three, and only three.**

**The alert hub.** Standing and long-lived, one per product. It is the
existing alert channel, adopted into Switch rather than created. Alerts land
here. The agent answers risky ones here, in the alert's thread, and on-call
triages in the same thread. Incidents are declared here. Each declared
incident gets a banner here, and the responder agent lives here permanently.
Its `instructions` carry the room's rules and the product's bindings, which is
what makes one design serve several products.

**The stakeholder channel.** Standing and long-lived, one per product. High-level
status only, for people who need to know that something is wrong and not how.
It already exists, and is adopted, not created.

**Which of the three the agent posts in is worth stating once.** Its rights
narrow as the audience widens.
- **The war room:** it posts freely.
- **The alert hub:** narrowly. Triage pings in alerts' threads; the banner; and
  under the banner, the milestones (war-room link, severity changes,
  mitigation, the close).
- **The stakeholder channel:** **never.** This is absolute, not a default: it
  is the widest audience, and the one where a wrong word costs most. The agent
  produces the text and a person sends it. The SOP does not name who posts,
  and this design puts a person there on purpose.

**The war room.** One per declared Sev0, built by the responder agent from the
template, dead after the RCA. Public: a war room that stakeholders cannot read
grows a second, worse war room in DMs.

**One room per incident, and the RCA is written in it.** This was a live
question. A second, linked postmortem room is defensible, and it is what a
group template would naturally produce. The answer is no. The RCA's raw
material is the war room's own timeline, so moving the write-up to a second
room separates the evidence from the analysis at exactly the moment you want
them together, and asks people to follow a link days after they stopped
caring. The war room stays open until the write-up is done.

### What is a thread

Everything that would otherwise fragment a room.

- **In the alert hub, two kinds.** One per alert: the triage conversation,
  opened by the agent's ping. One per incident: the banner and its
  milestones. A Sev1, which has no war room, lives entirely in its banner's
  thread.
- **In the war room:** one per line of investigation, one per situation report
  and its follow-ups, one for a tool's noisy output.

Switch threads bridge to real platform threads. Slack's difference is how it
*renders* them: a threaded reply appears only as a reply count under its
parent, not in the main flow. So on a Slack-bridged room, **anything the room
must not miss goes at the root.** A mention inside a thread still notifies the
person or group mentioned, which is why the triage ping can live in the
alert's thread and still reach on-call.

### What is neither

**The incident itself.** The incident is a PagerDuty record with an id, a
severity, a timeline and a resolution. The war room is a *conversation about*
it. Modelling the incident in Switch means two systems disagreeing about
severity at the worst possible moment. The room carries the incident number in
its name and a link to the record in its description, and that is the whole
relationship.

**The on-call rotation.** A rotation is a schedule. Switch has no schedule and
no concept of duty, and it does not need one. The ping goes to a Slack handle,
and the agent can ask PagerDuty who holds it. A "rotation room" would be a
room whose membership someone has to remember to edit every Monday: a worse
rotation than the one PagerDuty already runs.

**A per-service standing room.** Tempting, because the SOP's severity table is
organised by service, and each service has an owner. But what is actually
needed ("who owns ingestion, and what is its Sev1 threshold") is a lookup, not
a conversation. It belongs in a document the agent reads.

### The lifecycle, end to end

| Moment | What happens in Switch |
| --- | --- |
| Alert fires | Only an alert that mentions the agent reaches it. Every other alert is context in the hub. |
| **Risky alert** | The agent replies in the alert's thread. It mentions the on-call handle for the time of day, with the service's owner, Sev1 threshold and runbook. Once per alert; no ping for recoveries. |
| Triage | On-call works in that thread. The agent answers lookups. |
| Routine alert, no customer impact | On-call says so and resolves in PagerDuty. The agent stops. No room is ever created. |
| **Sev0 declared** | In the alert's thread. The agent reads PagerDuty, fills in the war-room template, invites the thread's people and the on-call engineers, and posts the banner. The template's kickoff starts the agent's session in the war room, which opens the room and asks for the Google Meet. |
| Sev1 declared | No war room. A banner in the hub. The update clock and the one-hour escalation reminder run in its thread. |
| Investigation | In the war room: threads per hypothesis. The agent answers lookups and keeps the timeline. |
| Situation report due | The agent's poll notices the posted deadline has passed. It drafts from the room, and a person posts the report to the hub and the stakeholder channel. |
| **Mitigated** | A person says so. The update clock stops. This is the stopping condition, not recovery or resolution. The room stays open. |
| An hour without progress | The SOP's rule, stated for Sev1: escalate to the service owner. The agent posts the notice at the hour, naming the owner from the SOP. The SOP gives no Sev0 rule. |
| Recovery confirmed, resolved | A person resolves in PagerDuty. The room stays open for the write-up. |
| RCA written | The agent drafts each section of the team's template in the room, from the timeline. A person creates the page. |
| Done | The agent archives the war room. The hub's session posts the close under the banner. Archiving is not deletion; the transcript survives. |

Two properties of that table are the design:

- **No room until a Sev0 is declared, and a raw alert gets at most one ping.**
  The common path, an alert that is not an incident, costs one threaded
  message and nothing else. A design that provisions a room per alert gets
  switched off within a week.
- **The room outlives the incident.** It closes when the RCA is written, not at
  recovery. That is the main argument for conducting the incident in a room
  at all.

### Cadence, and the thing that nudges

The SOP puts situation reports on a clock: hourly at Sev0, every four hours at
Sev1, in both cases **until the issue is mitigated**. That means not until it
is resolved, and not until the RCA is written. It sets no cadence at Sev2.
Something has to remember all of that, including the stopping condition, which
is the one an automated clock is most likely to miss.

**Switch cannot.** No scheduling primitive is exposed to a room: no cron, no
timers, nothing that wakes an agent on a clock. Switch runs periodic work
internally (connection and runtime-state sweeps, bridge renewal loops, timers
that batch attachments), but none of it is reachable from a room.

The agent's *host* can keep time, because Claude Code has cron. How you use it
matters more than whether you do.

A timer set to the SOP's interval is the obvious choice and the wrong one:
- It fires only while the session is **idle**, so an hourly job slips exactly
  when an incident is busy.
- Recurring jobs carry jitter, so it drifts.

A timer used as a **poll** fixes both. Fire every ten minutes. Each time,
compare what the agent posted against the clock, and act only if something is
due. Slip then costs minutes instead of an interval, and jitter stops
mattering, because the timer is no longer the deadline. A severity change is
picked up on the next pass, because the interval is re-read each time rather
than baked into a cron expression.

**Each session keeps the clock for its own room.** The agent runs as one
session per room (see [One session per room](#one-session-per-room)):
- The war-room session keeps the Sev0 clock in the war room.
- The hub session keeps the Sev1 clock in its banner's thread.

An earlier draft had one standing poll hopping between rooms to post. Under
per-room sessions that would evict whichever session it hopped into, so it is
gone.

The clock is kept in three layers:

1. **A deadline posted in the room:** `next update due HH:MM`, kept current by
   the agent. It survives a dead session and a missed poll, and the people who
   can see it enforce it. **It is the deadline.** The timer's only job is to
   make the agent look at it.
2. **The agent's own timer,** as the working mechanism: one durable poll per
   session with an open incident, deleted when that incident closes.
3. **A start-of-shift check, as a dead-man's switch.** A scheduled Slack
   workflow addresses the agent at the start of each coverage window, and
   on-call reads the answer. Its job is not the cadence. It is to notice that
   the agent is gone. A timer lives in the session, so it **shares a failure
   mode with the agent it is supposed to prompt**. A host restart (G22) or a
   crashed session takes the clock with the responder, silently. That is the
   one thing the agent cannot check for itself, and here the detector is a
   person who sees no answer.

Two rules follow, and both belong in the agent's instructions:
- The interval runs from the last update **sent**, not from the top of the
  hour, so a late update does not squeeze the next window.
- A draft that was posted and never sent must be called out. From outside the
  room it looks exactly like an update nobody wrote.

What remains missing is a schedule the *room* owns: visible, cancellable by
anyone, disposed of with the room. [Gaps](#gaps) G7.

## Watching the alert hub

Step 2 of the SOP asks two things of Switch that it does not do out of the box.
The agent must *see* an alert that does not mention it, and it must *notify* a
Slack group that is not one of Switch's own. Both work today with
configuration. Neither works by default, and one of them works only because of
an omission.

### Seeing an alert

**Switch does not hand an agent messages that do not address it.** The server
does send them. When the agent's runtime holds its own connection, it opens it
with the `all` filter, so it receives every message in its room. It then drops
each unaddressed one and counts it as missed
(`console/packages/switch-agent-runtime/src/bin.ts`, `handleEvent`). Under a
supervisor the filtering is the same. A dormant agent is worse off: what
starts a session is an *addressed* event, and a remote agent's sidecar listens
only for those. So an alert that does not
mention the agent never reaches it, live or dormant.

**The fix that needs no code: make the alert mention the agent.**
- Switch creates a Slack user group for each agent, named after it, so the
  agent appears in the `@` menu (where the workspace allows it to manage user
  groups).
- Switch bridges a third-party app's post (`bot_message` is on the adapter's
  allow-list, with a comment naming Datadog alerts).
- On the way in, it turns an agent's group tag, `<!subteam^…>`, into a mention
  of the agent.
- With an open addressing policy, an app's mention is admitted like anyone
  else's.

So a Datadog monitor whose message includes the agent's group tag wakes it.
Put the tag inside the monitor's `{{#is_alert}}` block, so recoveries do not.

That also answers a question the SOP leaves open: **what is "risky"?** The
monitors that carry the tag. The list is the team's to own, in the alerting
tool, and it is the one place to change it.

**The catch: the alert may arrive nearly empty.** Switch reads a Slack post's
plain text. Only when that text is empty does it fall back to the formatted
parts: Block Kit `section`, `header` and `rich_text` blocks, then the legacy
attachment (`core/switch_core/bridges/collaboration/slack/adapter.py`,
`_extract_rich_text`). An alerting tool puts its detail in exactly those
parts. If the mention lands in the plain text, the detail is dropped, and the
agent sees little more than the mention. Where Datadog puts it has to be
checked on a real monitor. The design copes either way: the agent treats the
post as a pointer and looks the alert up, through a Datadog connector if the
host has one. But this is G21, and the current SOP makes it load-bearing.

**What was rejected.** The agent could poll the hub's history on a timer
instead, and catch alerts that do not mention it. That needs a session kept
alive through every coverage window, and it shares the failure mode of every
host timer: when the agent dies, the watching dies with it. The right fix is
the opt-in that `room_join` events already have. An agent can be set to
receive join events per room, and those events carry a `listening` flag that
connectors use to decide whether to surface them. Unaddressed messages could
work the same way. [Gaps](#gaps) G28.

### Pinging on-call

**`@handle` notifies nobody.** On the way out, Switch rewrites `@name` into a
real Slack mention for two kinds of name only: people it has seen (`<@U…>`),
and agents' own groups (`<!subteam^…>`). Any other name stays plain text
(`core/switch_core/bridges/collaboration/slack/adapter.py`,
`_translate_mentions_to_slack`).

The workspace's other groups are known to it. It loads them at startup, and
on the way *in* it turns their tags into `@handle` text. On the way out it
does not reverse that. So when the agent writes `@<on-call handle>`, Slack
shows the handle and pings no one.

**The raw tag works.** An agent's text reaches Slack unescaped. Only labels,
such as display names spliced into a notice, are escaped, precisely so they
cannot write Slack markup. So an agent that writes `<!subteam^S…>` with the
group's id notifies the group. The ids go in the bindings, and the procedure
says to use the tag, never the handle.

**That works by omission, not by contract.** The same hole lets any agent
write `<!channel>` and notify a whole channel. It should become a decision:
translate known groups on the way out, and decide on purpose what raw markup
an agent may send. [Gaps](#gaps) G29.

A useful property, if it holds for the team: **when the handle is a group that
PagerDuty keeps in sync with the on-call schedule, the ping needs no identity
mapping at all.** The group *is* the rotation. Find out in the deploy guide's
Phase 0.

### Choosing the handle

On-call is business hours in two regions, and each region has a handle. The
agent picks by the clock. A time inside one window gets that region's handle.
A time inside both follows an overlap rule in the bindings. A time outside all
coverage gets **no mention**, and a line saying the alert landed outside
on-call hours. The SOP does not say what happens then, and the agent must not
pretend it does. A name that is technically on a rota but outside coverage is
worse than no name, because it reads as an answer.

The SOP writes its hours in named timezones. Whether they move with daylight
saving is something the bindings have to state, because the agent will
otherwise guess.

An unanswered ping is re-sent once after an interval the bindings set. That
is not in the SOP, which says only "a Slack mention". The design recommends it
because a single Slack mention replaces what used to be a repeating phone
page, and a single mention is easy to miss. The bindings can turn it off.

### The agent is on the alerting path

This is the consequence of the SOP's change that matters most. When PagerDuty
paged the on-call directly, the agent was a convenience downstream of a
declaration. If it was down, the room was built by hand. Now **a dead agent
means an alert nobody was told about.** Three things follow:

- **G22 is a prerequisite, not a follow-up.** A host reboot that leaves the
  sidecar down must not be something the team discovers from a missed alert.
- **The start-of-shift check is how a dead agent gets noticed**: by a person
  who sees no answer at the start of their shift, not by a customer.
- **Keep a backstop.** The on-call should keep Slack notifications for the
  alert hub on during their hours, so a dead agent degrades to "on-call sees
  the raw alert" rather than to silence. Whether PagerDuty should still notify
  on-call directly for the most severe monitors is the team's call, and a
  change to the SOP. This design flags it and does not make it.

## The incident-response agent

### The prior art: the workstream hub

Switch already runs a production pattern with this shape: the workstream hubs
that drive this repository's own development. Read from the inside, it is:

- **A standing hub room,** bridged to a channel, whose `instructions` are a
  complete operating manual. That includes a **bindings block** of instance
  data: ids, the bridge and channel type to create rooms on, the room group,
  the shared reference to put in every room.
- **A manager agent,** with the procedure in the agent rather than in the
  room.
- **One room per work item,** created by the agent: named to a convention,
  linked back to the hub, with `instructions` written for whoever picks it up.
- **A banner protocol:** exactly one root-level message per item in the hub,
  whose thread is that item's entire conversation.
- **An exclusive role** in the hub (`@manager`), so anyone reaches whoever is
  coordinating without knowing which agent that is.

Most of that transfers: an incident is a work item with a clock on it. Two
parts do not, and both are about the agent being on-demand where a workstream
manager is kept online:

- **The role does not transfer.** See
  [Address the agent by alias, not by role](#address-the-agent-by-alias-not-by-role).
- **The procedure moves out of the agent,** because the agent the team chose
  does other work too. See [The agent the team chose](#the-agent-the-team-chose).

### The alert hub's configuration

The hub's `instructions` carry the room's rules for people, the banner
protocol, a pointer to the agent's procedure, and the **Responder bindings**:
every product-specific value in one block.

- the coverage windows and each on-call handle's group tag;
- which alerts to act on;
- the PagerDuty ids and the severity map;
- the war-room threshold;
- the template's inputs, including the **internal** bridge;
- the stakeholder channel;
- the cadence;
- the close-out requirements.

The block itself is in the instruction set, block 1. Everything specific to the
company lives there. The procedure, the template and this document stay
generic and carry none of it.

**"Public" and "not external-facing" are two different axes, and only one of
them is `channel_type`.** A war room should be a public channel, readable by
anyone inside the company. It must never be visible outside it. The second of
those is decided by the **bridge**, not the channel type. A deployment
connected to more than one workspace (an internal one, and a partner or
customer-facing one) has a bridge for each. Room creation will provision on
whichever it is given.

The template's `bridge` parameter is typed `bridge`, so the server checks the
name exists before creating anything. Nothing checks *which* workspace it
faces. So the internal bridge is pinned in the bindings, and the procedure
says never to take a bridge from a message. Getting it wrong publishes an
outage to people outside the company, and it is a plausible mistake at 03:00.
Note that the stakeholder channel may well sit on a different workspace from
the war rooms. That is one more reason the agent never posts there.

### Address the agent by alias, not by role

The earlier design copied the workstream hub's exclusive role: `@responder`,
held by the agent, "so anyone reaches whoever is responding." That is wrong
for this agent, and the reason is specific.

**A role mention reaches only a role's *live* holder.** A role whose holder's
session has ended is shown as free, routes the mention to nobody, and makes
the admin client post a warning that the message may go unanswered
(`core/switch_core/clients/admin_client.py`, `_warn_unreachable_roles`). A
workstream manager is kept online, so its role is always held. The responder
is an **on-demand** (`auto_session`) agent: it starts when addressed, and its
sessions end. The moment its hub session ends, the lease lapses, `@responder`
addresses nobody, and nothing will ever start the agent again. That is the
worst failure available to an on-call agent: it looks configured and it is
unreachable.

An **alias** resolves to the agent itself, per room, whether or not a session
is running. So addressing it always reaches the agent, and an addressed message
is what starts one. The hub and every war room give the agent the alias
`responder`. An alias may not share a name with a room role, so a hub that
already has a `responder` role must lose it first.

A role earns its place again when there is a **second** agent, kept online as a
standby. Then the exclusive lease is what stops both acting at once. Name it
differently from the alias.

### One session per room

A remote agent's sidecar starts one session per room, and at most one session
of an agent may act in a given room. Connecting to a room takes it over: the
newcomer wins, and the displaced session silently stops receiving that room's
events. The earlier design told the agent to "leave the war room briefly and
go straight back" to post in the hub. Under per-room sessions, that hop evicts
the hub's own session. The hub then goes deaf to alerts until something wakes
it again.

So the design has one rule: **no session leaves its room.**
- The hub session builds the war room without connecting to it:
  `create_room_from_yaml`, `add_users_to_room`, `update_room` and `link_rooms`
  all take a room id.
- The template's kickoff addresses the agent in the new room, which starts the
  war-room session. That session runs the room.
- War-room milestones reach the banner's thread because the hub session reads
  each open war room without connecting (`read_context` takes a room id) and
  relays what it finds on each timer pass. The latency is at most one poll,
  and no session moves.

### What the agent does when an incident is declared

On-call replies in the alert's thread:

> `@responder` sev0 — no new findings for 40 minutes — PD 1287

The hub session then, in order:

1. **Reads the facts from PagerDuty:** the incident, its priority and service,
   and who is on call. If PagerDuty and the person disagree about severity, it
   says so and takes PagerDuty's.
2. **Checks it is a declaration.** If nobody has said a customer is affected,
   it asks, once, and waits.
3. **Branches on severity.** At Sev0 it builds the room. At Sev1 it posts a
   banner and runs the clock in its thread. At Sev2 it says there is nothing
   to run.
4. **Checks the room does not exist already.** A repeated declaration joins;
   it never creates a second room.
5. **Fills in the war-room template** with `create_room_from_yaml`.
6. **Finishes what the template cannot do:** it invites the thread's people
   and the on-call engineers, turns on its own join events, and links the room
   to the hub.
7. **Posts the banner** and replies in the alert's thread with the war-room
   link.

The template's kickoff then starts the war-room session, which posts the
opening message, asks for the Google Meet, and starts the clock.

### The banner protocol

One root-level message per declared incident in the hub, posted by the hub
session. Its thread is the incident's record in the hub: the war-room link,
severity changes, mitigation, and the close with the RCA link. A Sev1, which
has no war room, runs entirely in that thread: its update clock, its drafts,
and its escalation notice.

It is lifted from the workstream hubs, and it earns its place three times:

- A hub full of alerts sees one line per incident, not forty.
- The SOP wants situation reports in the alert channel. People post them under
  the banner of the incident they belong to, not between unrelated alerts.
- The incident's hub-side history is one thread.

## The war-room template

The war room is a **registered room template**, and the agent builds each war
room by filling it in. That reverses the earlier draft, which built the room
with `create_room` and demoted the YAML to documentation. The earlier draft
was written before any agent operation could instantiate a template.
`create_room_from_yaml` has since landed with the template work. It is the
agent-side mirror of the gateway's `POST /rooms/from-yaml`, and it provisions
as the agent's owner. So the reviewed artifact can be the mechanism, which is
what the ticket asked for.

The template is in the instruction set, block 3. Its parameters:

| Parameter | Type | Filled from |
| --- | --- | --- |
| `incident_id` | string, pattern-checked | PagerDuty |
| `severity` | enum: sev0, sev1, sev2 | the declaration, checked against PagerDuty |
| `service` | string | PagerDuty, as the SOP's severity table names it |
| `summary` | string | the declaration: what customers see |
| `incident_url` | string, must start `https://` | PagerDuty |
| `product`, `prefix` | string | the bindings |
| `bridge` | **bridge**: the server checks it exists | the bindings; the internal workspace |
| `responder_agent` | **agent**: checked | the bindings |
| `alert_hub` | **room**: checked | the bindings |
| `stakeholder_channel` | string | the bindings |
| four reference names | string | the bindings |
| `procedure`, `sop` | multiline string, with a default | the text of the hub's two documents |
| `visibility` | enum, default `channel_public` | fixed; folded away as advanced |

**How product content gets in without making the template product-specific.**
The war room needs the agent's procedure and the product's SOP as documents.
A template can create documents only inline; it cannot attach an existing one,
and it cannot attach a package. So the hub session passes each document's
full text in as a multiline input, and the template writes it into the room.
Each war room therefore carries a snapshot of the procedure and the SOP taken
when it opened. That is the right behaviour anyway: an incident should run
under the procedure it started with. The template itself stays identical for
every product.

**What was checked.** The template in block 3 was run through the shipped
parser (`parse_template`) and linter (`lint_template`) on `f4ada844`:
- The linter reports no errors and no warnings.
- Every placeholder resolves, with none left over.
- The procedure text passes through verbatim, braces included. Interpolation
  does not re-scan an input's own text.
- Left out, `procedure` and `sop` fall back to their defaults, which is the
  Console path.
- The room comes out named `example incident 1287`, and its Slack channel as
  `example-incident-1287`. The SOP's bracketed convention,
  `[Example] [Incident 1287]`, would slug to `example---incident-1287`. That is
  why the template uses the plain form: channel names are what responders
  type under pressure.

**Choices in it that are not arbitrary:**

- **`channel_type: "{visibility}"` is the whole-field form.** When a field is
  exactly one placeholder, the parameter's typed value is substituted as it
  is. A partial placeholder degrades to a string silently.
- **`write_visibility: private`**, and this is the one to argue about. Public
  write on a room means more than "participants may change it". It grants
  write to *any* principal in the tenant, member or not. Write on a room
  governs attaching references, defining and deleting roles, updating the room
  and archiving it. A war room that anyone's agent in the deployment can
  archive mid-incident is not a trade worth making. Adding people is governed
  separately, and admits existing members regardless.
- **No `users:`.** Who to invite is known only at declaration time, and a
  parameter cannot hold a list (G4). The hub session invites afterwards with
  `add_users_to_room`, which reports the names it could not resolve.
- **No `{$creator}`.** When an agent instantiates a template, the creator is
  the agent's *owner*. For a shared agent that is an account nobody on the
  rotation is, and inviting it would fail or add the wrong person.
- **A kickoff that addresses the agent.** Switch posts it on the creator's
  behalf once the room exists, and the agent applies its addressing policy to
  that creator. That starts the agent's session in the war room without the
  hub session having to move.
- **The `scribe` role is defined and assigned to nobody.** See
  [Roles, correctly scoped](#roles-correctly-scoped).

**What the template cannot do yet**, and what covers each:

| The war room needs | Template | Covered by |
| --- | --- | --- |
| A variable list of invitees | ✗ (G4) | `add_users_to_room` afterwards |
| The agent's own join events | ✗ (G9) | `update_room` afterwards |
| A link to the hub, a room outside the document | ✗ (G9) | `link_rooms` afterwards |
| Filing under the product's existing incidents group | ✗ (G9): a group document creates a new group each time | **nothing**: war rooms stay ungrouped until a person moves them |
| A package | ✗ (G9) | the documents travel as inputs instead |

Three of the five need a follow-up call, which the agent makes. One needs a
workaround that turns out better than the original. Only the room group has no
answer, and it is cosmetic.

**The Console fallback.** A registered template can be instantiated from
the Console's template screen, which renders the parameters as a form and
offers pickers for the entity-typed ones. So when the agent is unavailable, a
person can still create a correctly-shaped war room: they pick the internal
bridge and the hub, type the incident number and summary, and leave the
procedure and SOP to their defaults. That is a real improvement on the earlier
design, where no agent meant no room.

### Why the agent and the template together

The earlier draft argued "an agent, not a template". The honest version is a
division of labour:

- **The template is the shape:** reviewed, versioned, registered, identical
  for every product, and usable by a person with no agent at all.
- **The agent is everything a template cannot know or do:** which alert, which
  incident, who is on call, who answered in the thread. And everything after
  the room exists: invitations, the banner, the clock, the drafts, the
  timeline, the close.

A template is a function of its inputs, and somebody has to supply them. "Who
is on call right now" is not something a person should be typing into a form
at 03:00. The agent looks it up and passes it in, and the template makes the
room the same way every time.

### What is actually reusable

Standing incident response up for a second product means:

1. **The template:** unchanged.
2. **The Responder procedure document:** unchanged.
3. **The alert hub's instructions:** unchanged except the bindings block.
4. **The Incident response SOP document:** the second product's own.
5. **The alert-side configuration:** the tag on that product's monitors.

The varying part is one block of configuration and one document of the
product's own process, not a fork of the artifact. That is the reuse the
ticket asked for.

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
   reference to the alert hub. The war-room template attaches it to each war
   room by name.
3. **A PagerDuty bindings block** in the hub's instructions: service ids,
   escalation policy id, the severity map, and which schedule to read for on
   call.

Be clear about the limits of step 2, because the Jira precedent has the same
ones: a reference type gives an agent a display name, a paragraph of
instructions, a value hint and a list of URLs. Every reference type — built-in or
custom — has the same value shape. **No credential, no client, no tool, no
network call.** If nobody installs the MCP server, the agent reads a paragraph
telling it to do something it cannot do.

### What this closes, and what it does not

**Closed: knowing who is on call.** The agent asks PagerDuty for the on-call on
the relevant escalation policy, and gets an answer that is true at that moment.
Switch never models a rotation, never syncs a schedule, and never goes stale.

**Closed for the ping, by the SOP's current version.** The triage ping goes to
a Slack handle, not a person, so it needs no lookup at all. If the handle is a
group PagerDuty keeps in sync with the schedule, the ping reaches whoever is
on call without anyone, Switch included, knowing who that is.

**Not closed: reaching the person it names.** This is a genuine hole, found by
standing an agent up against a real PagerDuty rather than by reading code, and
earlier drafts of this document understated it.

PagerDuty identifies a person by name and email. Switch resolves a room invitee
by the *username the bridge knows*, matched against external users it has already
seen. An email is not a chat handle, so the lookup and the invite do not join up.
Concretely, the agent can reliably **say** "the on-call for payments is Jane
Doe", and cannot reliably **add or mention her**, unless she is already a known
user on that bridge under a name the agent can derive.

Three ways to close it, in increasing order of doing it properly:

1. **A static map**, maintained beside the service-owner map the SOP needs
   anyway: PagerDuty email → chat handle. One table, goes stale, works today, and
   costs nothing because the neighbouring table has to be written regardless.
2. **Populate chat handles on PagerDuty profiles**, so the mapping lives with the
   people rather than in a file. Better, and dependent on how that PagerDuty is
   administered.
3. **Resolve it live**, with a directory lookup from email to platform id. Correct
   and self-maintaining, and it needs a credential Switch does not hold and has
   nowhere to put — see [Gaps](#gaps) G20.

Take (1) now; it is a row in a table someone is already writing.

The current SOP adds a shortcut that covers most of it. **Everyone who replied
in the alert's thread has posted in the workspace, so the bridge knows them by
a name it can resolve.** They are exactly the people working the incident. So
the war room invites the thread's people first, and uses the name map only for
on-call engineers who have not spoken yet.

A fourth option deserves a second look now that the ping goes to a group:
**invite the members of a Slack user group.** The earlier draft rejected it as
a second copy of a rotation PagerDuty already owns. But if PagerDuty keeps the
group in sync, it is not a copy; it is PagerDuty's own list in a form the
bridge can read. The bridge already reads the workspace's groups at startup,
with a scope that also covers listing a group's members. That would make
"invite the on-call engineers" one step with no mapping.

Do not record this as closed: until one of these exists, the on-call engineers
who have not spoken in the thread are invited only if the name map covers
them. [Gaps](#gaps) G1.

And the related failure to design against: an unresolvable invitee comes back
unresolved rather than raising, so a war room can quietly come up short. The
agent must report the gap by name.

### The two real constraints on MCP

**MCP is per-machine, not per-agent.** Every connector plugin bundles exactly one
MCP server — the Switch runtime — and every provider declares MCP scope as
`global`; the capability schema does not admit any other value. Switch Console
writes a per-agent *launch profile* (model, reasoning effort, instructions) and
deliberately registers no MCP server in it. The MCP management UI was removed and
the config adapters that remain have no live callers.

So giving the responder a PagerDuty MCP server means editing the host's global
config, and every agent session on that machine gets it. That is an argument for
a dedicated responder host, not against the approach. A team reusing a shared
agent on a shared host (as this one is) should know that every other agent on
that machine gets PagerDuty read access too. [Gaps](#gaps) G19.

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

### The push direction, and what it is good for

Everything above is *pull*: the agent, while running, calls out to PagerDuty.
The other direction, an alerting tool causing something to happen in Switch,
is weaker, and the details matter because the failure is silent. The SOP's
current version leans on it for the triage ping, so the limits below now
shape the design rather than sit beside it.

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
  the room as context, and the responder never moves. This is the likely
  surprise, and it is why each monitor that should get a triage ping carries
  the agent's group in its message. See
  [Seeing an alert](#seeing-an-alert).
- **Most of an app's formatted content is dropped.** Rich blocks are read only
  when the message has no plain-text body. Even then only `section`, `header`
  and `rich_text` blocks are read. `context` and `actions` blocks, where
  PagerDuty puts service, urgency, assignee and its buttons, are discarded.
  Attachments are read only if no block yielded anything. An app usually sets a
  plain-text fallback for the notification preview, and a mention counts as
  plain text too. So Switch usually sees that one line and nothing else.
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

**So an app's mention is a trigger, not a message.** That makes it the right
tool for two jobs, and the wrong one for a third:
- **The triage ping.** The agent needs to know *that* a monitor fired, and it
  looks up *what* fired.
- **The start-of-shift check.** Only the mention matters.
- **Not the declaration.** There the content is the whole point, and most of
  it is what gets dropped.

A person declares, in the alert's thread, where the SOP already has a person
making exactly that decision. A PagerDuty-posted declaration can come later,
once the drill has proved the human path. The procedure treats it the same
way: as a reason to read the incident back from PagerDuty, never as the
source of its facts.

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

**A reboot ends it, and nothing brings it back.** Nothing registers a service,
so after a host restart someone has to start things again by hand. Under the
SOP's current version this is no longer an availability gap in a convenience.
The agent is how on-call learns of an alert, so a host that rebooted overnight
means alerts nobody was told about until someone noticed. Install a service
unit before go-live. [Gaps](#gaps) G22.

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

In practice the team has taken option 1 by reusing an agent that already runs
this way. See [The agent the team chose](#the-agent-the-team-chose).

## Making the agent user-agnostic

The rotation is the problem the agent has to survive. Six engineers take the
pager in turn; the agent must be the same agent for all of them, reachable by
whoever is on duty, and not degraded because the person who set it up is on
holiday.

### What the agent does, and does not, do

In the hub it pings on-call about alerts that need triage, answers lookups,
builds war rooms and keeps the banners current. In a war room it drafts
situation reports, keeps the timeline, greets arrivals, and archives the room
at the end. It does not page anyone by phone, set severity, resolve, decide,
or touch production. Rolling back and pushing fixes are people's actions. The
SOP's earlier draft said so explicitly, and the current one does not
contradict it. Extending that authority to a shared agent that six people can
address, and nobody can attribute, would be the worst decision available here.
See [the rule that makes it safe](#the-rule-that-makes-it-safe).

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

### The agent the team chose

The SOP names an agent the team already runs, rather than a new one: a shared
Claude Code agent on a remote host, which also does other work in other rooms.
Read from the live instance, it has the shape above exactly:
- no owner suffix in its name;
- `auto_session`, remote, with a sidecar on a shared host rather than a laptop;
- no addressing policy set, which Switch reads as open to anyone, so an
  alerting tool's mention is admitted;
- owned by the deployment's `Admin` account.

That makes it a reasonable first responder, and it changes this design in three
places:

1. **The procedure cannot live in its host definition.** Every session it
   runs, in every room, would load the incident procedure. So the procedure is
   a Switch document, attached to the alert hub and copied into each war room
   through the template. That turns out better than the original: the
   procedure follows the rooms, so replacing the agent later does not lose it.
2. **It is admin-owned.** That is the second alternative under
   [The recommendation](#the-recommendation), meant to be taken "knowingly and
   temporarily", and it is now the live state. An admin-owned agent has
   unbounded authority over every room and resource in the tenant. What
   bounds it is the rule that it never touches production and never acts
   unasked. The team should name who maintains it, and a date to revisit.
   G11 is still the real fix.
3. **A role lease is held per agent, across the whole instance** (G16). A
   multi-purpose agent that holds a role in one room can hold none anywhere
   else. The hub now addresses the agent by an alias instead (see
   [Address the agent by alias, not by role](#address-the-agent-by-alias-not-by-role)),
   so the incident design no longer takes the agent's one lease.

A hub set up from the earlier draft has the agent holding an exclusive
`responder` role. That role has to go before the alias can be set.

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

The earlier draft said room roles were the right tool at the hub. For an
on-demand agent they are not, and the constraints are easy to design past and
expensive to discover late.

**In the hub: an alias, not a role, while there is one agent.** A role mention
reaches only a live holder. A role auto-releases within seconds of its
holder's session ending, and an on-demand agent's sessions end, so
`@responder` would route to nobody at exactly the moment it is needed. See
[Address the agent by alias, not by role](#address-the-agent-by-alias-not-by-role).
The role's real strength, failover to another agent with no handoff, needs a
second agent that is kept online. When there is one, add an exclusive role
under a different name from the alias.

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

Hence the shape:
- The alias `responder`, in the hub and in every war room.
- No role held by the shared agent anywhere.
- `scribe` defined in each war room and assigned to nobody, there for a
  responder's own coding agent to pick up.
- Incident commander as a human convention, written into the room's
  instructions.

### The recommendation

**The destination:** one shared responder agent per product. Owned by a
dedicated non-admin service user. Running `auto_session` on shared, always-on
infrastructure, with a supervised sidecar and the PagerDuty MCP server
installed. Addressed by the alias `responder`. Open addressing policy. Never
run from an engineer's machine.

**Acceptable now,** and what the team has done: reuse an existing shared agent
that already meets every line except ownership, on the conditions in
[The agent the team chose](#the-agent-the-team-chose).

| Setting | Value | Why |
| --- | --- | --- |
| `name` | `<product>-responder` | The routing key. No person in it. |
| owner | a dedicated service user, **not** an admin | The agent inherits its owner's permissions exactly. |
| `connection_model` | `auto_session` | Comes online when addressed; nobody has to remember to start it. |
| host | one always-on machine, PagerDuty MCP installed | Online regardless of whose turn it is; one place to configure the integration. |
| sidecar | installed as a service | The agent is on the alerting path; a reboot must not silence it. |
| credential | one copy, on that host | Cannot be revoked per holder, so do not spread it. |
| addressing policy | open | A rotation cannot be enumerated, and an alerting tool's mention is refused under any restricted policy. |
| handle | alias `responder`, in the hub and every war room | Always wakes an on-demand agent. A role mention would not. |
| procedure | a Switch document, not the host's `CLAUDE.md` | Follows the rooms; survives replacing the agent; does not leak into its other work. |
| war rooms | built from the template per incident, archived after the RCA | Nothing about the agent changes per incident. |

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
belongs in the hub's instructions and in the Responder procedure.

The triage ping is the one thing the agent does unasked. It is the SOP's own
step, it is a notification rather than an action, and the alert it answers sits
directly above it in the thread.

Note that this rule is what makes PagerDuty access safe to grant. Reading
schedules and incidents is a lookup. Acknowledging, changing severity or
resolving is a decision, and those stay with the human even though the MCP server
would happily let the agent do them — so the `pagerduty` reference type's
instructions must say so explicitly, because the tool surface will not.

## Gaps

Thirty, grouped by what they block. Each says what is missing, why it matters
here, and a ticket to file. Sizes are rough: **S** is days, **M** is a sprint,
**L** is a project. The numbers are stable identifiers, not an ordering — they
are in the order they were found, and the grouping is what to read by.

**Read the header of group A first.** The gap that looked hardest is largely not
a gap.

### A. Knowing who is on call — mostly closed

Switch has no rotation, schedule or concept of duty, and after working the design
through, **it should not acquire one**. The agent asks PagerDuty and passes the
answer to `create_room`. What remains is smaller:

**G1 — There is no identity mapping across systems, and it is load-bearing.**
PagerDuty knows a person by name and email; the bridge knows them by a platform
handle; Switch resolves an invitee against external users it has already seen on
that bridge. Those do not join up, so the on-call *lookup* does not become an
on-call *invite*. This was confirmed against a live PagerDuty connection, not
inferred: an agent can read the schedule and still be unable to add or mention
the person it read.

Two distinct failures sit here. There is no mapping from an external identity to
a platform handle. And a name that cannot be resolved is returned as unresolved
rather than raising, so a war room quietly comes up short unless the caller
inspects the result.

> **Proposed ticket:** *Surface unresolved invitees as a first-class result* —
> so a caller must handle "these three could not be added" rather than reading it
> out of a list. **S**

> **Proposed ticket:** *Cross-system identity mapping* — a per-bridge map from an
> external identity (email, or a third-party user id) to a Switch user and its
> platform handle, so an agent holding a PagerDuty user can reach the person.
> Until it exists the mapping is a hand-maintained table in the hub's bindings.
> **M**

> **Proposed ticket:** *Invite a platform user group's members* — let room
> creation and `add_users_to_room` take a Slack user group and add its current
> members. Where PagerDuty keeps the on-call group in sync, this makes "invite
> the on-call engineers" one step with no mapping. The bridge already reads the
> workspace's groups. **S**

Until then, the design invites the people who replied in the alert's thread
(the bridge knows them, because they have posted) and uses the name map for
the rest.

### B. The template format

The design now builds every war room from a template, so these are on its
path. Re-checked on `f4ada844`. Two have narrowed a long way since the first
draft, because the template work has landed.

**G2 — An agent cannot read the template registry.**
The Console can now instantiate a registered template, and an agent can
provision from YAML it holds, through `create_room_from_yaml`. What an agent
cannot do is list, read or run a *registered* template. So the design keeps a
copy of the war-room template as a document in the alert hub, for the agent
to read, and the two copies must be kept in step by hand.

> **Ticket already filed:** the agent-facing template API (discover, run and
> save workspace templates, with owner-scoped permissions). When it lands,
> delete the hub's copy and point the procedure at the registered template.

**G3 — The gateway dashboard cannot supply parameter inputs.**
Narrowed to the gateway. The Console's template screen renders the declared
`params:` as a form, with pickers for entity-typed parameters, and is what the
design's manual fallback uses. The gateway's create-from-YAML page still posts
raw YAML with no `inputs`, so from there only a template whose every parameter
has a default works.

> **Proposed ticket:** *Parameter form in the gateway* — or retire the gateway's
> create-from-YAML page in favour of the Console's. **S**

**G4 — A parameter cannot hold a list.**
Types are `string`, `number`, `boolean`, `enum`. `agents:` and `users:` are
lists, so membership cannot be parameterised: `"alice,bob"` becomes one entry,
which in `users:` resolves to nobody and in `agents:` is a hard `Unknown agents:`
failure that aborts provisioning.

> **Proposed ticket:** *List-typed template parameters* — whole-field
> substitution that splices into the surrounding list. **M**

The design works around it: the template creates the room with nobody in it,
and the agent invites afterwards with `add_users_to_room`, which reports each
name it could not resolve.

**G9 — A room template is strictly less capable than the room creation it
wraps.**
Narrowed since the first draft: a template now sets `aliases`, and a group
document creates a group and links its own rooms. What `create_room` accepts
and a template still cannot express:
- **joining an existing group.** A group document always creates a new group,
  so every war room built from one would get its own.
- **a link to a room outside the document,** such as the alert hub;
- **`join_event_listeners`;**
- **`package_ids`;**
- **an existing library document.** `docs:` can only create documents inline.

The agent covers three of these with follow-up calls (`update_room`,
`link_rooms`) and a workaround (the documents travel as inputs). The group has
no cover, so war rooms stay ungrouped until a person moves them.

> **Proposed ticket:** *Pass the remaining room fields through the template
> provisioner* — `join_event_listeners`, `package_ids`, links to existing
> rooms, and a `group:` that names an existing group instead of creating one.
> The fields already exist on the config and are already validated. **S**

**G10 — Omitting `bridge:` silently means "the default bridge".**
The comment on the template's `bridge` field still says to omit it for an
internal-only room. Omitting it lands on the instance's default bridge, or on
no bridge if none is configured. (The `users:` half of the first draft's
finding is fixed: the guard now tests the resolved bridge.) The war-room
template names its bridge explicitly, as a `bridge`-typed parameter, so it is
not exposed. But a template author who trusts the comment publishes a room
they meant to keep internal.

> **Proposed ticket:** *Fix the `bridge:` comment, and add an explicit
> `internal_only:` key.* **S**

**A hazard, not a gap.** A `{word}` no parameter declares is left verbatim, on
purpose, so JSON braces in document content survive. A typo in a placeholder name
does not error — it ships into the created room. Lint before registering; the
registry blocks only three findings and treats the rest as advice.

### C. Driving the flow

**G5 — No channel command declares an incident.**
Half closed: `create_room_from_yaml` has landed, so an agent can build a room
from the reviewed template, which is what this design uses. (Reading the
template from the registry is G2.) What remains: an on-call engineer cannot
declare with a command. They address the agent in prose, which works but is
less discoverable than `/declare-incident`.

> **Proposed ticket:** *`!declare-incident` in-room command* — positional inputs,
> posts the new room's link back. **M**

**G6 — There is no generic alert ingress.**
Switch does listen for inbound HTTP from a platform and verify a signed caller —
the Teams bridge does exactly that — so the machinery exists. What does not is
anything generic: no endpoint accepting a third-party alert payload and mapping
it to a Switch action. This design does not need one. Alerts reach the agent as
Slack mentions (see G28 for the better version), and declarations come from
people. A team wanting fully automatic room creation does need one.

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
without connecting, but posting requires connecting. Under per-room sessions
that is worse than it sounds: a session that connects to another room evicts
the agent's own session there. That is why the design has the hub session
relay war-room milestones by reading on a timer, which adds up to one poll of
latency, and has people post situation reports to both channels.

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

**G30 — A role mention does not wake an on-demand agent.**
A role mention is routed only to a *live* holder. A lease lapses within seconds
of its holder's session ending, so a role held by an `auto_session` agent
routes to nobody whenever that agent is idle. The admin client warns, and
nothing starts the agent. The workstream hubs never notice, because their
managers are kept online. Any team that copies the pattern onto an on-demand
agent gets a role that works in testing, while the session is warm, and fails
overnight. The design sidesteps it with an alias, which gives up the role's
failover.

> **Proposed ticket:** *Wake a role's agent when no one holds it* — route a
> mention of an unheld role to the agents eligible for it (or its last holder)
> as an addressed event, so an on-demand agent starts and re-assumes. Pairs
> naturally with G17's eligibility. **M**

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

**G27 — On-call tooling has no built-in reference type, so every deployment
re-types the instructions.**
Switch ships four built-in reference types. The rest are user-defined, per
tenant, which means a `pagerduty` type is a setup step every deployment repeats
and — more to the point — a block of prose each one can edit.

That matters more here than it would elsewhere. A built-in exists precisely so
that its agent-facing instructions "stay under code review", and PagerDuty's
instructions are where the **read-only boundary** lives: never acknowledge,
resolve or re-prioritise. That is a safety rule the tool surface will not
enforce, so where it is written and who can quietly change it is a real
question, not a filing preference.

The precedent is exact. The built-in `jira` type ships instructions pointing at
an MCP connector Switch does not itself provide, which is the same shape a
`pagerduty` type would take.

The change is small — one entry in the built-in registry plus a test, no
migration, no gateway change, since built-ins are never database rows and the UI
renders whatever the type list returns. The decision worth making is not
PagerDuty specifically but **what earns a built-in slot**, because the next
request is Datadog and the one after is Sentry.

> **Proposed ticket:** *Built-in reference types for on-call and observability
> tooling* — add `pagerduty` first, with a test pinning the read-only wording the
> way the Jira test pins its connector wording, and write down the rule for what
> qualifies so the next vendor is a decision already made. Note the published
> docs still describe reference types as a closed set of four; that sentence is
> already stale and wants correcting in the docs repository. **S**

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

The SOP's current version makes this load-bearing. The agent now answers raw
alerts, and an alert whose mention lands in the plain text arrives with its
detail stripped. The design copes, by treating the post as a pointer and
looking the alert up, but only where the host has a connector to look it up
with.

> **Proposed ticket:** *Extend Block Kit extraction* — read `context` blocks and
> merge attachments rather than treating them as a fallback; drop a message whose
> extracted body is empty rather than relaying it. **S**

> **Proposed ticket:** *Bridge message edits* — relay `message_changed` as an
> edit, or at minimum as a new message noting the original was amended. **M**

**G28 — An agent cannot opt in to unaddressed messages.**
The server already sends every message in a room to a connection that asks for
them, and the runtime's own connection does. The runtime throws the unaddressed
ones away, and a remote agent's
sidecar starts sessions only on addressed events. So an agent that should
watch a channel (an alert channel, above all) sees only what mentions it. The
design gets around this by putting the agent's group in every monitor's
message. That works, but it spreads a Switch concern into the alerting tool's
configuration, one monitor at a time. `room_join` events already solve the same
problem: a per-room, per-agent opt-in, carried on the event as a `listening`
flag, with connectors deciding whether to surface it.

> **Proposed ticket:** *Per-room message listeners* — the `room_join` listener
> model for unaddressed messages: an opt-in per room and agent, optionally
> limited to app senders, surfaced by the runtime and honoured by the sidecar
> when deciding to start a session. Mostly client-side, since the server
> already delivers the messages. **M**

**G29 — An agent cannot notify a Slack user group, except by writing raw
markup.**
On the way out, the Slack bridge turns `@name` into a real mention only for
people it has seen and for agents' own groups. It loads the workspace's other
groups at startup, and translates their tags on the way *in*, but not on the
way out. So `@<on-call handle>` from an agent notifies nobody. The workaround
the design uses, writing the raw `<!subteam^…>` tag, works only because an
agent's text is not escaped on the way out. The same omission lets any agent
write `<!channel>` or `<!here>` and notify a whole channel.

> **Proposed ticket:** *Outbound user-group mentions, and a rule for raw
> markup* — translate a known workspace group's `@handle` into its tag on the
> way out, and decide deliberately which raw Slack markup an agent's message
> may carry (at minimum, defuse `<!channel>`, `<!here>` and `<!everyone>`
> unless a room allows them). **S**

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
Switch Console deploys the sidecar into a tmux session on the host. Nothing
registers a service, so after a restart the agent, and any Console-managed
server on that host, stay down until someone starts them by hand. Every other
gap here degrades a feature. This one makes the responder absent, which is the
only requirement it really has. Under the SOP's current version, an absent
responder means alerts nobody was told about.

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

**Nothing, to run it. Two things, before anyone depends on it.**

The SOP's current version runs on Switch today with no change to Switch:

- The war room is built from a registered template, by an agent calling
  `create_room_from_yaml`.
- PagerDuty is reached the way Jira already is.
- Alerts wake the agent because each monitor mentions its group.
- The agent notifies on-call by writing the group's raw tag.

Standing it up is configuration, one template, two documents and a few lines
in the alerting tool. The deploy guide in the instruction set is the
checklist.

Four compromises in that, worth naming out loud rather than discovering:

- **Identity.** The agent is admin-owned, or would be personally owned. Until
  G11 exists, neither is right.
- **Host.** The machine is the team's by convention only. Each engineer holds a
  private record of it (G24), and nothing provisions it (G25).
- **Availability.** A reboot takes the responder offline until someone
  notices (G22). The agent is now how on-call hears about an alert, so that
  means missed alerts, not a missing convenience.
- **Two workarounds that work by omission.** The ping relies on the bridge not
  escaping an agent's text (G29). Seeing alerts relies on every monitor
  carrying the agent's group, while Switch drops most of what those monitors
  say (G28, G21).

The first three are one problem seen three times. A shared agent needs a
team-owned identity, a team-owned host and team-owned credentials, and today
each of them resolves to a particular person's. Incident response did not
cause that. It is the first use case where it stops being untidy and starts
being unacceptable.

**Then, in order of value per unit of work:**

1. **G22 — supervise the remote sidecar.** The agent is on the alerting path.
   Everything else on this list degrades a feature; this one means alerts that
   reach nobody.
2. **G29 — outbound user-group mentions, and a rule for raw markup.** Small.
   It turns the triage ping from an accident into a contract, and closes the
   `<!channel>` hole for every agent, not only this one.
3. **G21 — extend what Switch keeps of an app's post.** Small. The agent stops
   depending on a connector to find out what fired.
4. **G11 — a service account.** Small. The ownership compromise ends here.
5. **G30 — wake a role's agent when no one holds it.** Lets the workstream-hub
   role pattern work for on-demand agents, and gives the responder failover
   back.
6. **G28 — per-room message listeners.** Moves "which alerts get triaged" from
   one line per monitor to one setting per room.
7. **G23 — detect a session that cannot receive events.** Small. It removes a
   failure mode where the room believes an agent is listening and it is not.
8. **G2 — the agent-facing template API** (already filed). Retires the hub's
   copy of the template.
9. **G9 — the remaining room fields in templates.** Lets war rooms file under
   the product's group, and removes the agent's follow-up calls.
10. **G8 — mirror to a linked room,** then **G7 — scheduled room actions.** The
    first removes the relay-by-polling. The second gives the clock a home that
    does not die with the agent.
11. **G25 — a reference agent host,** then **G24 — server-side host records.**
    Together they turn "we run a responder" from a favour someone is doing into
    infrastructure.
12. Everything else, as it starts to hurt.

The honest summary: **the design needs no Switch changes to run. Before anyone
should depend on it, it needs one operational fix (a supervised sidecar) and
one small code change (group mentions on purpose, not by omission).** Neither
is specific to incident response. The first is about a shared agent needing a
substrate the team owns. The second is about agents needing to reach people
through the platform's own groups. That is a good sign for the SOP, since it
is not blocked on Switch growing a new concept. It is also a fair warning for
Switch: the same gaps will surface for every shared agent after this one.
