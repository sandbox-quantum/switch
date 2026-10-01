# Incident response on Switch

How a team's on-call manual runs on Switch. The pieces:

- the product's alert channel, adopted as a standing hub;
- a shared responder agent that triages every alert, pings on-call when one
  needs a person, declares incidents in PagerDuty in three defined cases, and
  builds a war room when a Sev0 is declared;
- a registered room template that the agent runs;
- PagerDuty, reached the same way Jira already is.

This is a design, not an implementation. Nothing here has been built. Where
Switch cannot do what the manual needs, the gap is named and a ticket proposed
rather than designed around. If you read only one section, read
[Gaps](#gaps).

Written against `main` at `514d5ba4`, re-checked at `f4ada844` for how room
events reach an agent, how Slack mentions are translated in each direction, how
a role mention is routed, and the template format; and at `2aeeb80d` for the
agent-facing template operations and inbound Slack reactions; and at `f9a295c1`
for usage budgets. The hosting,
ownership and credential claims were checked at `514d5ba4`. Every claim about
how Switch behaves was checked against the code rather than recalled. Where a
behaviour is surprising enough to be worth confirming, the file it lives in is
named.

**The configuration is in a companion document,**
[`incident-response-instructions.md`](incident-response-instructions.md): every
block of instruction text, labelled with the field it goes in, the war-room
template, and a step-by-step deploy guide. This document is the argument; that
one is the configuration.

- [Scope](#scope)
- [The on-call manual, and where Switch is in it](#the-on-call-manual-and-where-switch-is-in-it)
- [The agent's scope](#the-agents-scope)
- [Mapping the process onto rooms](#mapping-the-process-onto-rooms)
- [Watching the alert hub](#watching-the-alert-hub)
- [Declaring in PagerDuty](#declaring-in-pagerduty)
- [The incident-response agent](#the-incident-response-agent)
- [The war-room template](#the-war-room-template)
- [Reaching PagerDuty](#reaching-pagerduty)
- [Where the agent runs](#where-the-agent-runs)
- [Making the agent user-agnostic](#making-the-agent-user-agnostic)
- [Gaps](#gaps)
- [What to build first](#what-to-build-first)

## Scope

The subject is a specific team's on-call manual: a lightweight, post-launch,
business-hours rotation in two regions. It alerts on-call with a Slack mention,
pages through PagerDuty only when an incident is declared, and coordinates in
Slack. It is deliberately temporary: it says it will be replaced once a 24/7
rotation and real tooling exist. So the design optimises for reuse and
disposal: a shape a team can stand up per product and throw away, not a
standing structure to maintain.

The manual belongs to one product team, and this document does not reproduce
it. The team's channel names, on-call handles and service owners are
configuration, not content. They live in one bindings block, supplied per
product. That keeps this design reusable across products, and keeps a public
repository free of one team's internal routing.

**Out of scope for this design.** Configuring the PagerDuty or Datadog products
themselves, beyond what the design needs from each; Switch Console's side of
any of this; anything that needs code to exist before it can be described.
Where the manual depends on such a thing, it appears in [Gaps](#gaps).

## The on-call manual, and where Switch is in it

The manual has three parts that matter here, and one that matters by its
absence.

### The alert process

A flow diagram on the manual's daily alert-handling page, which the manual
calls the source of truth, and a page written for agents that explains it.
Compressed:

1. **An alert fires** and lands in the product's alert channel.
2. **Critical?** A critical alert short-circuits every triage step: the agent
   declares an incident at once, and PagerDuty pages both regions' on-callers.
3. **Seen by** the agent or a person, whoever gets there first. The manual is
   explicit that the two routes are equivalent in standing; neither is a
   fallback for the other.
   - **The agent** triages, and decides "on-caller needed?". No: the alert ends
     as "no action". Yes: it pings the on-caller.
   - **A person.** If they are the on-caller, they triage. If not, they triage
     and decide "on-caller needed?". No: "ignored". Yes: they hand off to the
     on-caller, and the manual insists the hand-off is to a named person, not a
     post in the channel.
4. **Wait for the on-caller to respond.** Both the ping and the hand-off
   converge here. What happens next depends on why the on-caller is silent,
   not how long:
   - **Replied within the response window:** the on-caller triages.
   - **No reply, inside the on-call window:** an unresponsive on-caller. The
     agent declares the incident so PagerDuty pages both regions, and the alert
     still waits for the on-caller to triage it.
   - **No reply, outside the window:** nobody is on call. The alert waits.
     Escalating would page two people for a condition the process says to wait
     on.
5. **The on-caller's verdict:** incident, ignore, or handled (muted, say). An
   earlier version of the diagram, the one still pictured on the manual's page,
   sends a muted alert that is still firing when its mute expires back into
   the hub as a new alert; the current source drops that loop as not worth
   modelling. The procedure keeps it: an alert whose thread has ended is
   triaged afresh when it fires again.
   **Incident** means a person declares, and the agent runs the declaration.
   Declaring is the only bridge into PagerDuty, which then pages both regions'
   on-callers and manages the incident to closure.

The page for agents adds a standard for triage: it establishes **blast radius,
novelty and whether the problem is already known**, and "anything short of all
three is acknowledgement, not triage". It adds that triage ends in a stated
disposition, recorded in the thread; that "ignored" is a verdict, never a
default; that reacting to a message is not a response; and that the agent must
never report a clean result without saying what it checked. It also warns that
some monitors go quiet after the first alert, so silence is not recovery.

### The incident process

Everything after a declaration:

- **Severity** on a Sev0 / Sev1 / Sev2 scale, with a table of Sev1 thresholds
  and owners per service.
- **At Sev0,** the incident is logged in PagerDuty as
  `[Feature] [Severity] [Symptom]`, **Switch creates a dedicated channel and
  invites the on-call engineers to it**, and a video call is opened.
- **At Sev1** there is no war room. On-call works from the runbooks and
  escalates to the service owner if stuck for an hour.
- **Updates on a clock:** hourly at Sev0, every four hours at Sev1, until the
  issue is mitigated. Each is a five-field situation report, posted to both the
  alert channel and the stakeholder channel.
- **Resolve:** recovery confirmed and resolved in PagerDuty, the RCA written in
  the team's template, and for Sev0 an RCA meeting within five business days.

The incident process page now sits in the manual beside an incident
prioritisation page and an incident page written for agents. Both are still
empty. Until they are written, the incident process page is the source; the
prioritisation page looks set to become the source for severity, and perhaps
for what makes an alert critical.

### The rest of the manual: the on-caller's job

Daily duties (a checklist, dashboards, a reliability sweep run with the
on-caller's own tooling), releases (weekly promotions, gated by the on-caller
and "never on the calendar alone"), schedules and overrides, onboarding, and
improvement work (about 30% of an on-call week). **None of it is the agent's.**
It matters here because it draws the agent's boundary, which the manual never
states in one place. See [The agent's scope](#the-agents-scope).

### Where Switch appears

Twice, as it always has, and now with more weight:

- **In the alert process, the agent is an actor.** It triages, pings, waits,
  and declares. It is on the path by which on-call learns of an alert *and* the
  path by which an unanswered alert reaches PagerDuty. See
  [The agent is on the paging path](#the-agent-is-on-the-paging-path).
- **In the incident process, Switch creates the war room** and runs the
  paperwork around it.

The rest is still not Switch's. Severity, the resolve and the incident record
are PagerDuty's. Diagnosis is Datadog's and the runbooks'. The alert's
lifecycle (muting, tuning) is the on-caller's. **The manual does not need
Switch to run incident response.** It needs Switch to put every alert in front
of the right person with the right context, to escalate the ones nobody
answers, and, after a declaration, to produce a correctly-shaped room within
seconds and be useful inside it. A design that moved severity, paging or the
incident record into Switch would be building a competitor to PagerDuty that
nobody asked for.

### What changed from the previous version of this design

The previous version was written against the incident process page alone. The
alert process changes it in these places:

- **The agent declares incidents in PagerDuty.** The previous version forbade
  any PagerDuty write. The diagram makes the agent the one that runs every
  declaration, and the one that declares on its own in two cases. See
  [Declaring in PagerDuty](#declaring-in-pagerduty).
- **The agent observes every alert,** not a hand-picked list of "risky"
  monitors, and triages each to a stated standard, with its evidence, in the
  thread. "Say nothing for warnings" is gone.
- **The re-ping is gone.** An unanswered ping now waits a response window and,
  inside on-call hours, becomes a declaration that pages. The re-ping was this
  design's addition; the manual's answer is better.
- **The response clock runs on a person's hand-off too,** not only the agent's
  ping.
- **Critical alerts skip triage** and go straight to a declaration.
- **The agent's scope is stated,** because the manual now describes a whole
  on-call job, most of which the agent must not touch.
- **The war-room template is run from the registry.** Agents can now list,
  read and run registered templates, so the document copy of the YAML is
  gone.

### Where the manual and the live setup disagree

Checked against the team's PagerDuty, Datadog and on-call sync configuration
as committed in its infrastructure repository.

- **Declaration is not the only bridge into PagerDuty today.** The monitors'
  shared notification line also notifies PagerDuty, so almost every alert
  already opens a PagerDuty incident, at low urgency. The incident process's
  triage step ("resolve in PagerDuty with notes") assumes this; the diagram
  assumes the opposite. The procedure copes with both: a declaration raises the
  alert's existing incident if there is one, and creates one only if not. The
  team should still pick one.
- **A declaration would not page anyone today.** The PagerDuty service is set
  to low urgency, deliberately, while the monitors bed in. A declared incident
  must be raised to high urgency, and it has to be confirmed that this pages.
  That is a go-live blocker.
- **"Critical" is not defined anywhere.** No monitor sets a priority, and
  nothing else marks one as critical. The design has critical monitors carry a
  literal marker next to the agent's mention. Until one does, the short-circuit
  never fires.
- **The response window is TBC** on the diagram itself.
- **Names.** The page for agents names the alert channel slightly differently
  from the real one, and the incident process names an on-call handle with a
  suffix the synced groups do not have. Both are typos in the manual; the
  bindings carry the real values.
- **"Manage alerts, e.g. mute" versus "never mute".** The page's objectives list
  muting; its agent role forbids it. The design takes the stricter reading:
  suggest, never change.
- **The diagram pictured on the manual's page is an older render than its
  source.** It has no on-call window, pages one on-caller rather than both, and
  still shows a mute-expiry loop. The page for agents and the diagram's source
  describe the newer version, and so does this design. The team should upload
  the current render, since the page calls the picture the source of truth.
- **The page for agents has a few sentences with words missing.** None changes
  the process as the diagram shows it, but the team should fix them before an
  agent reads the page as a source.

### Where this plan departs from the manual's wording

The team should know exactly where the plan does not do what the manual's text
says, and why. Each point is also a Phase 1 decision in the deploy guide.

- **Who picks the severity of an agent-declared incident.** The manual does not
  say. The agent never chooses one: it declares `Sev TBD`, and the on-caller
  states the severity.
- **The Google Meet sits under the Switch step.** Nothing on the agent's host
  can create one without a calendar connector. So the agent asks for one, and a
  person creates it.
- **The channel name.** `<prefix> incident <number>`, not the process's
  `[<Product>] [Incident #]`, because Switch turns brackets and spaces into runs
  of hyphens when it derives a Slack channel name.
- **"P0 / P1 / P2" is read as Sev0 / Sev1 / Sev2,** because PagerDuty has no
  P0.
- **Stakeholder updates and situation reports are one post.** If the team means
  two, the agent drafts both.
- **Additions the manual does not ask for,** each marked in the bindings:
  - a rule for when triage says on-call is needed (the manual names the
    decision but not the rule);
  - which handle to ping outside the window;
  - a start-of-shift check that also lists alerts left waiting or without a
    verdict;
  - suggestions about noisy alerts, at most daily per monitor;
  - inviting the people who answered in the alert's thread, as well as the
    on-call engineers;
  - a public war room;
  - an agent that never posts to the stakeholder channel.

### The questions the manual has not answered

All listed for the team to decide in the deploy guide's Phase 1:

- the response window;
- which monitors are critical;
- which bridge into PagerDuty the team wants;
- the severity of an agent-declared incident;
- whether a recovery before the deadline cancels an auto-declaration;
- on-call days, the overlap rule, and daylight saving;
- which on-call engineers are invited to a war room;
- the escalation rule at Sev0 (only Sev1's is stated);
- when the Sev1 clock stops, and whether Sev2 has one.

## The agent's scope

The manual describes a whole on-call job. The agent does a small, named part of
it, and the boundary has to be written down, because the agent the team chose
is a general coding agent with a shell, and "while you're in there, promote
staging" is exactly the request it will get.

**In scope: five jobs.**

1. **Alert triage:** the agent's lane of the diagram.
2. **Declaring incidents in PagerDuty,** in three cases: a person tells it to,
   a critical alert fires, or on-call has not responded within the window
   during on-call hours.
3. **Incident support** after a declaration: the war room, the banner, the
   update clock, drafts, the timeline, and the close-out.
4. **Lookups** about the above.
5. **Suggestions about noisy alerts,** in the alert's thread.

**Out of scope, by name:** alert lifecycle (mute, resolve, snooze, edit a
monitor); any PagerDuty write beyond declaring; the rota; releases and
promotions; the on-caller's daily routine; improvement work; production;
customer-impact and severity verdicts; escalating outside hours; the
stakeholder channel. The instruction set tabulates each with whose it is and
where the manual says so.

Three choices in that list are worth defending:

- **Releases are out, even though the agent could run them.** The releases page
  makes the on-caller the gate ("never promote on the calendar alone"), and a
  promotion is a production change. An agent that six people can address and
  nobody can attribute (G15) must not hold a gate.
- **The reliability sweep is out, even though it is an agent skill.** It is a
  tool the on-caller runs in their own session, at their own time, and it says
  of itself that it is not incident response. Running it from the alert hub
  would fill the hub with findings nobody asked for.
- **Improvement work is out of these rooms, not out of the agent.** The same
  agent may fix bugs elsewhere. It does not start from an alert.

**Acting unasked.** The agent does five things without a person's written
request, each in the thread of the alert or incident that caused it: the triage
note, the ping, the two declarations it makes on its own, and the update clock.
Everything else needs a request in the room. This is what keeps the room
transcript an audit trail; see [The rule that makes it safe](#the-rule-that-makes-it-safe).

## Mapping the process onto rooms

Switch has one structural primitive that matters here, the room, plus threads
inside it and links between rooms. Getting the mapping right is mostly a matter
of refusing to over-model.

### What is a room

**Three, and only three.**

**The alert hub.** Standing and long-lived, one per product. It is the existing
alert channel, adopted into Switch rather than created. Every alert lands here.
The agent triages here, in each alert's thread, and on-call answers in the same
thread. Incidents are declared here. Each declared incident gets a banner here,
and the responder agent lives here permanently. Its `instructions` carry the
room's rules and the product's bindings, which is what makes one design serve
several products.

**The stakeholder channel.** Standing and long-lived, one per product.
High-level status only, for people who need to know that something is wrong and
not how. It already exists, and is adopted, not created.

**Which of the three the agent posts in is worth stating once.** Its rights
narrow as the audience widens.
- **The war room:** it posts freely.
- **The alert hub:** narrowly. Triage notes and pings in alerts' threads; the
  banner; and under the banner, the milestones.
- **The stakeholder channel:** **never.** This is absolute, not a default: it
  is the widest audience, and the one where a wrong word costs most. The agent
  produces the text and a person sends it.

**The war room.** One per declared Sev0, built by the responder agent from the
template, dead after the RCA. Public: a war room that stakeholders cannot read
grows a second, worse war room in DMs.

**One room per incident, and the RCA is written in it.** The RCA's raw material
is the war room's own timeline, so moving the write-up to a second room
separates the evidence from the analysis at exactly the moment you want them
together. The war room stays open until the write-up is done.

### What is a thread

Everything that would otherwise fragment a room.

- **In the alert hub, two kinds.** One per alert: the alert's post, the agent's
  triage note, and the conversation to a verdict. One per incident: the banner
  and its milestones. A Sev1, which has no war room, lives entirely in its
  banner's thread.
- **In the war room:** one per line of investigation, one per situation report
  and its follow-ups, one for a tool's noisy output.

Switch threads bridge to real platform threads. Slack's difference is how it
*renders* them: a threaded reply appears only as a reply count under its
parent. So on a Slack-bridged room, **anything the room must not miss goes at
the root.** A mention inside a thread still notifies the person or group
mentioned, which is why the ping can live in the alert's thread and still reach
on-call.

### What is neither

**The incident itself.** The incident is a PagerDuty record with an id, a
severity, a timeline and a resolution. The war room is a *conversation about*
it. The room carries the incident number in its name and a link to the record
in its description, and that is the whole relationship.

**The on-call rotation.** A rotation is a schedule. Switch has no schedule and
no concept of duty, and it does not need one. The ping goes to a Slack group
that a sync service keeps in step with PagerDuty, and the agent asks PagerDuty
who is on call when it needs a name.

**A per-service standing room.** What is actually needed ("who owns ingestion,
and what is its Sev1 threshold") is a lookup, not a conversation. It belongs in
a document the agent reads.

### The lifecycle, end to end

| Moment | What happens in Switch |
| --- | --- |
| Alert fires | Every monitor mentions the agent, so every alert wakes it. |
| **Critical alert** | The agent declares at once: PagerDuty pages both regions. A banner in the hub. Triage still falls to the on-caller. |
| Seen by a person first | The agent stays out of the thread, and starts the response clock in case of a hand-off. |
| **Seen by the agent** | It triages (blast radius, novelty, already known), says what it checked, and records "on-call needed: yes/no" in the alert's thread. |
| On-call not needed | The note is the end: "no action", on the record. |
| **On-call needed** | The same note mentions the on-call handle for the time of day, with the service's owner, threshold, dashboard and runbook. The response clock starts. |
| On-call replies in time | The on-caller triages. The agent answers lookups. |
| **No reply, inside hours** | The agent declares, `Sev TBD`, so PagerDuty pages both regions. A banner. The alert still waits for the on-caller. |
| No reply, outside hours | Nothing escalates. One line saying it waits, and when on-call starts. The start-of-shift check lists it. |
| Verdict: ignore or handled | One line from the agent, and the alert ends. |
| **Verdict: incident** | The agent declares with the stated severity. At Sev0 it runs the war-room template, invites the thread's people and the on-call engineers, and links the room. The template's kickoff starts the agent's session in the war room, which opens the room and asks for the Google Meet. |
| Sev1 declared | No war room. The update clock and the one-hour escalation notice run in the banner's thread. |
| Situation report due | The agent's poll notices the posted deadline has passed. It drafts, and a person posts the report to the hub and the stakeholder channel. |
| **Mitigated** | A person says so. The update clock stops. The room stays open. |
| Recovery confirmed, resolved | A person resolves in PagerDuty. The room stays open for the write-up. |
| RCA written | The agent drafts each section of the team's template in the room, from the timeline. A person creates the page. |
| Done | The agent archives the war room. The hub's session posts the close under the banner. |

Two properties of that table are the design:

- **No room until a Sev0 is declared, and an alert costs one threaded note.**
  The common path, an alert that needs nobody, costs one message and nothing
  else. A design that provisions a room per alert gets switched off within a
  week.
- **The room outlives the incident.** It closes when the RCA is written, not at
  recovery.

### Cadence, and the thing that nudges

Two clocks now run in the hub, and one in each war room:

- **The response window** on each alert waiting for on-call. It decides whether
  PagerDuty pages.
- **The update clock** on each open incident: hourly at Sev0, every four hours
  at Sev1, **until the issue is mitigated**.

**Switch cannot keep either.** No scheduling primitive is exposed to a room: no
cron, no timers, nothing that wakes an agent on a clock. The agent's *host* can
keep time, because Claude Code has cron. How you use it matters more than
whether you do.

**The response window** is a one-shot job at the deadline, backed by the
session's recurring poll. It has to be close to exact, because a late check
means a late page.

**The update clock** is a poll, not an alarm. A timer set to the process's
interval fires only while the session is idle, so an hourly job slips exactly
when an incident is busy, and recurring jobs drift. A poll every few minutes
that compares a posted deadline with the time now fixes both: slip costs
minutes, drift stops mattering, and a severity change is picked up on the next
pass.

**Each session keeps the clocks for its own room.** The war-room session keeps
the Sev0 clock. The hub session keeps the response windows, the Sev1 clocks,
and the relay of war-room milestones.

The clocks are kept in three layers:

1. **A deadline posted in the room:** `next update due HH:MM`. It survives a
   dead session, and the people who can see it enforce it. (The response window
   has no posted line: a person replying is what ends it.)
2. **The agent's own timer,** as the working mechanism. **Never a sleep inside
   the agent's turn**: in a drill, an agent that waited with sleeps took about
   three minutes to answer anything while a wait was pending, against ten
   seconds otherwise.
3. **Backstops outside the agent.** A renotifying monitor wakes the agent again
   while the alert is still firing, which gives it a second chance at a
   response check its timer missed. A start-of-shift check addresses the agent
   at the start of each window, and a person reads the answer. A timer lives in
   the session, so it **shares a failure mode with the agent it is supposed to
   prompt**. The start-of-shift check is the one detector that does not.

What remains missing is a schedule the *room* owns: visible, cancellable by
anyone, disposed of with the room, and kept somewhere that does not go down
with the agent. [Gaps](#gaps) G7. The alert process makes it load-bearing: the
response window now decides whether anyone is paged.

## Watching the alert hub

The alert process asks three things of Switch that it does not do out of the
box. The agent must *see* every alert, it must *notify* a Slack group that is
not one of Switch's own, and it must *wait* on a person without holding a
session open. All three work today with configuration. None works by default,
and one works only because of an omission.

### Seeing every alert

**Switch does not hand an agent messages that do not address it.** The server
does send them. When the agent's runtime holds its own connection, it opens it
with the `all` filter, so it receives every message in its room. It then drops
each unaddressed one and counts it as missed
(`console/packages/switch-agent-runtime/src/bin.ts`, `handleEvent`). Under a
supervisor the filtering is the same. A dormant agent is worse off: what starts
a session is an *addressed* event, and a remote agent's sidecar listens only
for those. So an alert that does not mention the agent never reaches it, live
or dormant.

**The fix that needs no code: make every alert mention the agent.**
- Switch creates a Slack user group for each agent, named after it, so the
  agent appears in the `@` menu (where the workspace allows it to manage user
  groups).
- Switch bridges a third-party app's post (`bot_message` is on the adapter's
  allow-list, with a comment naming Datadog alerts).
- On the way in, it turns an agent's group tag, `<!subteam^…>`, into a mention
  of the agent.
- With an open addressing policy, an app's mention is admitted like anyone
  else's.

So a Datadog monitor whose message includes the agent's group tag wakes it. The
alert process says the agent observes *all* alerts, so the tag goes in every
monitor. Where the monitors are managed as code with a shared notification line
(the team's are), that is one change, not one per monitor. It goes in the
alert, warning and no-data blocks, and never the recovery block, so recoveries
do not wake it.

**Critical is a marker beside the mention.** Nothing in the alerting tool marks
an alert critical today. The design has critical monitors carry a literal
marker next to the agent's tag, because the text beside the mention is the one
part of the post Switch is sure to keep (below). The list of critical monitors
lives in the alerting tool, and the agent treats nothing else as critical,
however it reads.

**The catch: the alert may arrive nearly empty.** Switch reads a Slack post's
plain text. Only when that text is empty does it fall back to the formatted
parts: Block Kit `section`, `header` and `rich_text` blocks, then the legacy
attachment (`core/switch_core/bridges/collaboration/slack/adapter.py`,
`_extract_rich_text`). An alerting tool puts its detail in exactly those parts.
If the mention lands in the plain text, the detail is dropped, and the agent
sees little more than the mention. The design copes: the agent treats the post
as a pointer and looks the alert up, through a Datadog connector if the host has
one. But the alert process makes it load-bearing: the agent cannot triage what
it cannot see. G21.

**What was rejected.** The agent could poll the hub's history on a timer
instead, and catch alerts that do not mention it. That needs a session kept
alive through every window, and it shares the failure mode of every host timer.
The right fix is the opt-in that `room_join` events already have. [Gaps](#gaps)
G28.

### Pinging on-call

**`@handle` notifies nobody.** On the way out, Switch rewrites `@name` into a
real Slack mention for two kinds of name only: people it has seen (`<@U…>`),
and agents' own groups (`<!subteam^…>`). Any other name stays plain text
(`core/switch_core/bridges/collaboration/slack/adapter.py`,
`_translate_mentions_to_slack`). The workspace's other groups are known to it,
and on the way *in* it turns their tags into `@handle` text, but on the way out
it does not reverse that.

**The raw tag works.** An agent's text reaches Slack unescaped. Only labels,
such as display names spliced into a notice, are escaped. So an agent that
writes `<!subteam^S…>` with the group's id notifies the group. The ids go in
the bindings, and the procedure says to use the tag, never the handle.

**That works by omission, not by contract.** The same hole lets any agent write
`<!channel>` and notify a whole channel. [Gaps](#gaps) G29. The team has already
hit the visible half of this: a comment on its incident process says an agent
"can't ping a group", which is true of `@handle` and not of the raw tag. The
drill settles it. If the tag does not notify in practice, the fallback is the
one path Switch does translate: the agent mentions the on-call *person* by
name, taken from PagerDuty through the name map. That makes G1 a dependency of
the ping as well as of the response check.

**The handles are the rotation.** The team runs a sync service that mirrors the
PagerDuty schedule into one Slack group per region, overrides included. So the
ping reaches whoever is on call without anyone, Switch included, knowing who
that is.

### Choosing the handle

The on-call window is the union of two regions' business hours. The agent
picks by the clock: one region in hours gets its handle; both in hours follows
an overlap rule in the bindings. Outside the window, the diagram still pings
(the wait comes after), so the bindings name which handle: the recommendation
is the region whose hours start next, with the time they start, because that is
who will see it first. The ping says it is outside hours, so nobody reads a
mention as a demand to work out of hours, which the manual says nobody is
expected to do.

The manual writes its hours in named timezones. Whether they move with daylight
saving is something the bindings have to state, because the agent will
otherwise guess.

### Waiting on a person

The response check is the heart of the diagram, and it has three parts the
design has to get right.

**What counts as a reply.** A message in the alert's thread from the person on
call. Two things do not count, and neither needs enforcing:
- **A reaction.** The manual says reacting "stops the clock socially but not
  actually". Switch does not bridge inbound Slack reactions at all, so the
  agent never sees one.
- **Anyone else's reply.** A non-on-caller's "looking" does not answer for the
  on-caller. Their hand-off, though, restarts the clock.

To tell whether a reply came from the on-caller, the agent asks PagerDuty who
is on call and matches the name to the reply's sender. That match is the
identity problem in G1, and it is now on the paging path: a name the agent
cannot match counts as not the on-caller, which errs towards paging. The
bindings' name map has to cover everyone on both rotations.

**When it runs.** A one-shot job at the deadline, which is the response window
after the later of the ping and any hand-off, backed by the session's
recurring poll and by the monitor's renotifications.

**What it decides.** From the thread: the on-caller replied (done); a person
said "not needed" (done); nobody stated any disposition (the agent triages it
itself, because "ignored because nobody looked" is the failure the manual
names); or on-call is needed and silent, in which case the window decides
between declaring and waiting.

### The agent is on the paging path

This is the consequence that matters most. In the previous version the agent
was how on-call *learned* of an alert. Now it is also how an unanswered alert
*reaches PagerDuty*, and how a critical one does. **A dead agent means an
alert nobody was told about, and an incident nobody was paged for.** Three
things follow:

- **G22 is a prerequisite, not a follow-up.** A host reboot that leaves the
  sidecar down must not be something the team discovers from a missed page.
- **The start-of-shift check is how a dead agent gets noticed**: by a person
  who sees no answer, not by a customer.
- **A usage budget can stop it too.** Switch now stops an agent that has
  reached a budget covering it: messages addressed to it are refused and so are
  its own posts, until the period resets. A workspace-wide budget covers every
  agent, with no exemption, and an agent that also does other work spends
  against the same budget. Switch posts a notice when it refuses, so this one
  is visible, but alerts go untriaged until the reset. G31.
- **Keep a backstop.** On-call should keep Slack notifications for the alert
  hub on during their hours, so a dead agent degrades to "on-call sees the raw
  alert". Whether critical monitors should also page PagerDuty directly, as a
  second route that does not depend on the agent, is the team's call and a
  change to the diagram. This design flags it and does not make it.

## Declaring in PagerDuty

The previous version's hardest rule was that the agent never writes to
PagerDuty. The alert process moves that line, and the move is right: a
declaration is the step that pages, and the diagram puts the agent on it in
every case.

### The three cases

- **A person says so.** The on-caller's verdict is "incident", with a severity.
  The agent runs the declaration they made.
- **A critical alert.** The marker is the decision; the agent carries it out.
- **No response inside the window.** The diagram's words: an unresponsive
  on-caller, so the agent declares so that PagerDuty pages. This is the one
  case where the agent's own judgment ("on-call needed") leads to a page, and
  it is bounded twice: by the window, and by the on-call hours.

In all three the agent decides *that* PagerDuty pages. It never decides *how
bad* it is: an agent-declared incident is `Sev TBD` until the on-caller says
otherwise, and a priority is set only from a severity a person stated.

### Raise, or create

Because the monitors already open a low-urgency PagerDuty incident per alert
(see [Where the manual and the live setup disagree](#where-the-manual-and-the-live-setup-disagree)),
"declare" cannot simply mean "create": that would put two incidents on one
alert. So a declaration **raises the alert's existing incident** (high
urgency, the title convention) when there is one, and **creates one** only when
there is not. That works whichever way the team settles the routing.

### Idempotency, and failing loudly

A person can declare twice, an alert can renotify, and a retry looks exactly
like a new event. Before writing, the agent looks for a banner in the hub and
an open, high-urgency incident for the alert. After writing, it reads the
incident back. **If the write failed or cannot be confirmed, it says nobody has
been paged and mentions both handles.** That is the one failure the design
cannot allow to be quiet.

### What the write access costs

- **It is all or nothing.** A PagerDuty connector's write mode typically
  enables every write, acknowledge and resolve included. So the boundary
  between "declare" and "resolve" is the reference type's instructions and the
  procedure, not the tool. That is why the reference type now says "write only
  what a procedure attached to your room names", rather than "read only".
- **It is per machine.** Connectors are configured per host, so every agent on
  the responder's host can write to PagerDuty. G19.
- **It is attributed to a PagerDuty user.** Writes through the REST API act as
  a user. Use a dedicated PagerDuty user for the responder, so a declaration
  reads as the agent's and not as a person's.

### Why the rule that makes it safe still holds

The previous version's safety argument was that the agent takes no
consequential action a person did not ask for, so the room transcript is the
audit log. Two of the declarations are unasked. They keep the property because
each is triggered by something on the record: the alert, and either the marker
or the elapsed window, with the agent's message naming which case applied. The
transcript still explains every write.

## The incident-response agent

### The prior art: the workstream hub

Switch already runs a production pattern with this shape: the workstream hubs
that drive this repository's own development. Read from the inside, it is:

- **A standing hub room,** bridged to a channel, whose `instructions` are a
  complete operating manual. That includes a **bindings block** of instance
  data.
- **A manager agent,** with the procedure in the agent rather than in the room.
- **One room per work item,** created by the agent: named to a convention,
  linked back to the hub, with `instructions` written for whoever picks it up.
- **A banner protocol:** exactly one root-level message per item in the hub,
  whose thread is that item's entire conversation.
- **An exclusive role** in the hub (`@manager`).

Most of that transfers: an incident is a work item with a clock on it. Two
parts do not, and both are about the agent being on-demand where a workstream
manager is kept online:

- **The role does not transfer.** See
  [Address the agent by alias, not by role](#address-the-agent-by-alias-not-by-role).
- **The procedure moves out of the agent,** because the agent the team chose
  does other work too. See [The agent the team chose](#the-agent-the-team-chose).

### The alert hub's configuration

The hub's `instructions` carry the room's rules for people (how to reply, the
three verdicts, how to hand off, what the agent does on its own and never
does), the banner protocol, a pointer to the agent's procedure, and the
**Responder bindings**: every product-specific value in one block.

- on-call hours, the window, and each handle's group tag;
- the response window;
- the critical marker, environments, dashboards, and where to look for a deploy
  in flight;
- the PagerDuty service, how a declaration is written, and the severity map;
- the war-room threshold and the template's inputs, including the **internal**
  bridge;
- the stakeholder channel;
- the cadence and escalation;
- the close-out requirements.

**"Public" and "not external-facing" are two different axes, and only one of
them is `channel_type`.** A war room should be a public channel, readable by
anyone inside the company. It must never be visible outside it. The second of
those is decided by the **bridge**. A deployment connected to more than one
workspace has a bridge for each, and room creation provisions on whichever it
is given. The template's `bridge` parameter is typed `bridge`, so the server
checks the name exists; nothing checks *which* workspace it faces. So the
internal bridge is pinned in the bindings, and the procedure says never to take
a bridge from a message.

### Address the agent by alias, not by role

**A role mention reaches only a role's *live* holder.** A role whose holder's
session has ended is shown as free, routes the mention to nobody, and makes the
admin client post a warning that the message may go unanswered
(`core/switch_core/clients/admin_client.py`, `_warn_unreachable_roles`). The
responder is an **on-demand** (`auto_session`) agent: it starts when addressed,
and its sessions end. The moment its hub session ends, a `@responder` role
addresses nobody, and nothing will ever start the agent again. That is the
worst failure available to an on-call agent: it looks configured and it is
unreachable.

An **alias** resolves to the agent itself, per room, whether or not a session
is running. So addressing it always reaches the agent, and an addressed message
is what starts one. The hub and every war room give the agent the alias
`responder`. An alias may not share a name with a room role, so a hub that
already has a `responder` role must lose it first.

A role earns its place again when there is a **second** agent, kept online as a
standby. Name it differently from the alias.

### One session per room

A remote agent's sidecar starts one session per room, and at most one session
of an agent may act in a given room. Connecting to a room takes it over: the
newcomer wins, and the displaced session silently stops receiving that room's
events. A drill saw this live: a second session of one agent started in the
drill room, and the two knocked each other out.

So the design has one rule: **no session leaves its room.**
- The hub session builds the war room without connecting to it: `run_template`,
  `add_users_to_room`, `update_room` and `link_rooms` all work on a room the
  session is not in.
- The template's kickoff addresses the agent in the new room, which starts the
  war-room session. That session runs the room.
- War-room milestones reach the banner's thread because the hub session reads
  each open war room without connecting (`read_context` takes a room id) and
  relays what it finds on each poll.

### The banner protocol

One root-level message per declared incident in the hub, posted by the hub
session. It says who declared it, and in which case. Its thread is the
incident's record in the hub: the war-room link, severity changes, mitigation,
and the close with the RCA link. A Sev1 runs entirely in that thread.

- A hub full of alerts sees one line per incident, not forty.
- The process wants situation reports in the alert channel. People post them
  under the banner of the incident they belong to.
- The incident's hub-side history is one thread.

## The war-room template

The war room is a **registered, shared room template**, and the agent builds
each war room by running it. The previous version kept a copy of the YAML as a
document for the agent to read, because agents could not yet read the
registry. They can now: `list_templates`, `get_template` and `run_template`
have landed, and `run_template` provisions through the same path as
`create_room_from_yaml`, as the agent's owner. So there is one copy, the
reviewed one.

The template is in the instruction set, block 3. Its parameters:

| Parameter | Type | Filled from |
| --- | --- | --- |
| `incident_id` | string, pattern-checked | PagerDuty |
| `severity` | enum: sev0, sev1, sev2 | the declaration, checked against PagerDuty |
| `service` | string | PagerDuty, as the SOP's severity table names it |
| `summary` | string | the declaration: what customers see |
| `incident_url` | string, must start `https://` | PagerDuty |
| `declared_by` | string, with a default | who declared, and in which case |
| `product`, `prefix` | string | the bindings |
| `bridge` | **bridge**: the server checks it exists | the bindings; the internal workspace |
| `responder_agent` | **agent**: checked | the bindings |
| `alert_hub` | **room**: checked | the bindings |
| `stakeholder_channel` | string | the bindings |
| four reference names | string | the bindings |
| `procedure`, `sop` | multiline string, with a default | the text of the hub's two documents |
| `visibility` | enum, default `channel_public` | fixed; folded away as advanced |

**How product content gets in without making the template product-specific.**
A template can create documents only inline; it cannot attach an existing one,
and it cannot attach a package. So the hub session passes each document's full
text in as a multiline input, and the template writes it into the room. Each
war room therefore carries a snapshot of the procedure and the SOP taken when it
opened, which is the right behaviour anyway: an incident should run under the
procedure it started with.

**What was checked.** The template in block 3 was run through the shipped
parser (`parse_template`) and linter (`lint_template`) on `2aeeb80d`:
- The linter reports no errors and no warnings.
- Every placeholder resolves, with none left over.
- The procedure text passes through verbatim, braces included.
- Left out, `procedure` and `sop` fall back to their defaults, which is the
  Console path.
- The room comes out named `example incident 1287`, and its Slack channel as
  `example-incident-1287`. The bracketed convention, `[Example] [Incident 1287]`,
  would slug to `example---incident-1287`. That is why the template uses the
  plain form: channel names are what responders type under pressure.

**Choices in it that are not arbitrary:**

- **`channel_type: "{visibility}"` is the whole-field form.** When a field is
  exactly one placeholder, the parameter's typed value is substituted as it is.
- **`write_visibility: private`.** Public write on a room grants write to *any*
  principal in the tenant, member or not, and write governs attaching
  references, roles, updating and archiving. A war room that anyone's agent can
  archive mid-incident is not a trade worth making.
- **No `users:`.** Who to invite is known only at declaration time, and a
  parameter cannot hold a list (G4). The hub session invites afterwards with
  `add_users_to_room`, which reports the names it could not resolve.
- **No `{$creator}`.** When an agent runs a template, the creator is the
  agent's *owner*, an account nobody on the rotation is.
- **A kickoff that addresses the agent,** which starts its war-room session
  without the hub session having to move.
- **The `scribe` role is defined and assigned to nobody.** See
  [Roles, correctly scoped](#roles-correctly-scoped).

**What the template cannot do yet**, and what covers each:

| The war room needs | Template | Covered by |
| --- | --- | --- |
| A variable list of invitees | ✗ (G4) | `add_users_to_room` afterwards |
| The agent's own join events | ✗ (G9) | `update_room` afterwards |
| A link to the hub, a room outside the document | ✗ (G9) | `link_rooms` afterwards |
| Filing under the product's existing incidents group | ✗ (G9) | **nothing**: war rooms stay ungrouped until a person moves them |
| A package | ✗ (G9) | the documents travel as inputs instead |

**The Console fallback.** A person can run the registered template from the
Console's template screen, which renders the parameters as a form with pickers
for the entity-typed ones. So when the agent is unavailable, a person can still
create a correctly-shaped war room.

### Why the agent and the template together

- **The template is the shape:** reviewed, versioned, registered, identical for
  every product, and usable by a person with no agent at all.
- **The agent is everything a template cannot know or do:** which alert, which
  incident, who is on call, who answered in the thread, and everything after the
  room exists.

### What is actually reusable

Standing on-call up for a second product means:

1. **The template:** unchanged.
2. **The Responder procedure document:** unchanged.
3. **The alert hub's instructions:** unchanged except the bindings block.
4. **The On-call SOP document:** the second product's own.
5. **The alert-side configuration:** the mention in that product's monitors,
   and the critical marker.

## Reaching PagerDuty

The question was whether an agent can use an API or MCP for PagerDuty, "kinda
like what we do with Jira". The answer is yes, and it is worth being precise
about what the Jira pattern actually is, because it is not an integration.

### What the Jira pattern actually is

Switch's entire Jira presence is a **reference type**
(`core/switch_core/bridges/resource/registry.py`) whose agent-facing
instructions tell the agent it needs access to the project and "an agent
connector that can fetch Jira content on your behalf — typically the Atlassian
MCP connector". Switch ships **the pointer and the prose**. It ships no
connector. The capability comes from an MCP server a human installed on the
host the agent runs on, and the instance specifics live in the hub room's
bindings block.

That is the pattern to copy:

1. **A PagerDuty connector on the responder's host,** with write access for
   declaring. This is where the capability comes from.
2. **A `pagerduty` reference type**, user-defined, with instructions saying
   what the agent may do with it and what it must never do. Attach the
   reference to the alert hub; the war-room template attaches it to each war
   room by name.
3. **PagerDuty bindings** in the hub's instructions: the service, escalation
   policy and schedule, how a declaration is written, and the severity map.

A reference type gives an agent a display name, a paragraph of instructions, a
value hint and a list of URLs. **No credential, no client, no tool, no network
call.** If nobody installs the connector, the agent reads a paragraph telling it
to do something it cannot do.

### What this closes, and what it does not

**Closed: knowing who is on call.** The agent asks PagerDuty, and gets an answer
that is true at that moment. Switch never models a rotation, never syncs a
schedule, and never goes stale.

**Closed for the ping.** It goes to a Slack group the sync service keeps in
step with PagerDuty, so it needs no lookup at all.

**Not closed: matching a person across systems.** PagerDuty identifies a person
by name and email. Switch resolves a room invitee by the username the bridge
knows, and shows a reply's sender the same way. Those do not join up. So the
agent can reliably **say** "the on-call for payments is Jane Doe", and cannot
reliably **invite** her, or **recognise her reply** in the alert's thread,
unless a map says which chat user she is. The response check now depends on
the second of those.

Three ways to close it, in increasing order of doing it properly:

1. **A static map,** PagerDuty user → chat handle, in the bindings. Goes stale,
   works today.
2. **Chat handles on PagerDuty profiles,** so the mapping lives with the
   people.
3. **Resolve it live,** with a directory lookup from email to platform id. It
   needs a credential Switch does not hold (G20).

Take (1) now. The war room also invites the people who replied in the alert's
thread, whom the bridge already knows. And the sync service proves the other
half is solvable: it maps PagerDuty users to Slack users by email, with an
override table for the few that differ. [Gaps](#gaps) G1.

### The two real constraints on MCP

**MCP is per-machine, not per-agent.** Every provider declares MCP scope as
`global`, and Switch Console writes a per-agent launch profile that registers
no MCP server. So a PagerDuty connector with write access on the responder's
host gives every agent on that machine write access to PagerDuty. That is an
argument for a dedicated responder host. [Gaps](#gaps) G19.

**There is no agent-scoped secret storage.** A PagerDuty token lives in the
host's environment, or in Switch Console's per-provider environment map, which
is plaintext and applies to every agent of that provider. Switch neither scopes
it, rotates it, nor audits its use. [Gaps](#gaps) G20.

### The alternative: a server-side connector

The only Switch-managed, server-held, credential-carrying integration point. A
PagerDuty connector would discover one synthetic agent whose job is to answer
PagerDuty questions in a room: a *conversational* PagerDuty agent the responder
talks to, not a *tool* it calls, with the token in cleartext in Postgres.
Recommend against it here; remember it for a future where PagerDuty access
should be a deployment-wide service.

### The push direction, and what it is good for

Everything above is *pull*. The other direction, an alerting tool causing
something to happen in Switch, is weaker, and the details matter because the
failure is silent.

**What works.** A third-party app posting into a bridged Slack channel is not
filtered out, and if its message contains the agent's group tag, the agent is
addressed and an `auto_session` agent is spawned to handle it.

**What does not.**

- **An alert with no mention wakes nothing.** Only *addressed* events start a
  session.
- **Most of an app's formatted content is dropped.** Rich blocks are read only
  when the message has no plain-text body, and then only `section`, `header` and
  `rich_text`; `context` and `actions` blocks are discarded. Attachments are read
  only if no block yielded anything.
- **Edits never arrive.** `message_changed` and `message_deleted` are dropped,
  so an alert edited in place to "Resolved" leaves Switch's copy saying it is
  open.
- **An owner-scoped addressing policy turns this into noise.** A bot has no
  Switch account, so under a restricted policy every app-triggered mention is
  refused, with a message posted into the channel.
- **`!commands` from a workflow never wake a dormant agent.**

**So an app's mention is a trigger, not a message.** That makes it the right
tool for the alert (the agent needs to know *that* a monitor fired, and looks up
*what* fired) and for the start-of-shift check. A person's verdict, where the
content is the whole point, comes from a person in the thread.

### Why not a PagerDuty MCP channel

Claude Code has **channels**: an MCP server can push into a session. It is the
wrong call here. It must ship as a marketplace plugin, needs a flag on argv at
launch, is **ignored silently** on Vertex, Bedrock or any third-party provider,
and is a research preview. Switch built the channel, ships it, and then disables
it for every session Switch Console manages. The cheaper route gets the same
outcome: make the alert arrive as an addressed message in a room, which the
Slack path already does.

## Where the agent runs

The responder must be online when nobody's laptop is. Switch has a first-class
answer, and it is the same one the existing always-on agents use.

### The remote host and its sidecar

A **remote agent** is the same agent with its process on an SSH host. Nothing
in Switch core distinguishes it. The agent runs inside `tmux`, beside a
**sidecar** the app deploys: a headless re-implementation of the session logic
that starts sessions, keeps them connected to their rooms, and injects messages
into their pane, with no app running anywhere. The sidecar holds the
notification stream for a remote agent, filtered to addressed events, and
spawns a session per room.

Two consequences specific to running unattended, both of which matter more for
an incident responder than for anything else Switch hosts:

**Permission bypass defaults on.** A remote agent is onboarded with permission
bypass enabled, so a prompt nobody can answer is not a hang. For a responder
with shell access and PagerDuty write, that is a decision to take explicitly.
It is also the strongest argument for
[the rule that makes it safe](#the-rule-that-makes-it-safe): the agent's
restraint has to come from its instructions and from the narrowness of its
scope.

**A reboot ends it, and nothing brings it back.** Nothing registers a service.
The agent is how on-call learns of an alert and how an unanswered alert gets
paged, so a host that rebooted overnight means alerts nobody was told about and
incidents nobody was paged for. Install a service unit before go-live.
[Gaps](#gaps) G22.

### Whose host is it?

A shared responder should not run on an engineer's personal VM: the agent is
the team's, so every substrate under it should be too.

**Switch has no concept of a team-owned host.** A remote host is a record in
Switch Console's own local database: an `~/.ssh/config` alias and a display
name. Two engineers onboarding the same machine create two unrelated records.
**And nothing provisions one.** No Terraform, no image, and no agent workload in
the Helm chart.

#### The three options, and the trade that decides it

1. **A shared host, team-owned by convention.** A machine in team
   infrastructure with a shared service account and rotation-wide SSH. Works
   today; the agent's credentials and sidecar state live on the host, and any
   engineer with SSH can adopt it.
2. **A server-side connector,** which needs no host and is registered as a
   service the deployment offers everyone, but has **no pre-invocation
   mediation and auto-approves permissions permanently**.
3. **Build the missing piece:** a server-side host record, or a containerised
   sidecar.

**The option that solves ownership is the one with the least governance.** For
an agent with a shell and PagerDuty write, addressed by six people during the
worst hour of the quarter, that decides it. **Take option 1 now,** and treat
option 2 as the destination once a connector agent can be governed. The team
has taken option 1 by reusing an agent that already runs this way.

## Making the agent user-agnostic

The rotation is the problem the agent has to survive. Six engineers take the
pager in turn; the agent must be the same agent for all of them, reachable by
whoever is on duty, and not degraded because the person who set it up is on
holiday.

### What the existing shared agents get right

The existing shared agents on the live instance share a shape:

- **A name with no owner suffix.** The name is the routing key for everything:
  mentions, the Slack user group the bridge mints, room aliases, `target_names`.
- **`auto_session` with a watcher on a shared always-on host.** The agent is
  online regardless of whose turn it is.
- **An open addressing policy.** A rotating group cannot be enumerated, and an
  alerting tool's mention is refused under any restricted policy.
- **Membership by invitation.** The agent belongs to rooms, not to a room.
- **A description written at the reader.**

Copy all of that.

### The agent the team chose

The manual names an agent the team already runs: a shared Claude Code agent on
a remote host, which also does other work in other rooms. Read from the live
instance, it has the shape above: no owner suffix, `auto_session`, remote, no
addressing policy set (which Switch reads as open), and owned by the
deployment's `Admin` account. That changes the design in three places:

1. **The procedure cannot live in its host definition.** Every session it runs,
   in every room, would load it. So the procedure is a Switch document, attached
   to the alert hub and copied into each war room through the template. The
   scope section matters more for the same reason: this agent *can* do the
   on-caller's other jobs, and will be asked to.
2. **It is admin-owned.** An admin-owned agent has unbounded authority over
   every room and resource in the tenant. What bounds it is its scope and the
   rule that it acts only on the record. The team should name who maintains it,
   and a date to revisit. G11 is the real fix.
3. **A role lease is held per agent, across the whole instance** (G16). The hub
   addresses the agent by an alias instead, so the incident design takes no
   lease from its other work.
4. **Its other work spends its budget.** If the workspace sets usage budgets,
   the agent's coding work and its on-call work draw on the same one, and
   reaching it stops both (G31). That is the strongest argument yet for a
   dedicated responder agent.

### What breaks

**1. Owner permissions.** An agent inherits *exactly* its owner's permissions,
and `User.role == "admin"` is a global bypass on every read, write and delete.
Own a responder with a dedicated **non-admin** service user instead.

**2. There is nothing good to own it with.** The one shared-owner construct, the
synthetic bootstrap account, is non-admin, which is right, but nobody can sign
in as it on a password deployment, and nobody can **reveal its credential**.
Ownership is also permanent: no endpoint changes `owner_id`. **User-agnostic
means owned by a non-person, not owned by nobody**: an agent with no owner
cannot create or attach references, or edit itself. G11.

**3. The default addressing policy locks the rotation out.** Every agent
registered through an HTTP path is created owner-only. Widen it through
`PUT /agents/{id}/addressing-policy`. The gateway's policy editor drops the
symbolic `owner` rules on save. G12.

**4. The offline nudge wakes the wrong person.** Addressed with nothing to start
it, an `auto_session` agent tells the room to go and wake its *owner*: for a
shared responder, an account nobody watches. G13.

**5. One credential, no rotation, no per-holder revocation.** The responder's
credential lives in exactly one place, on the shared host, and is never
distributed. G14. Two people *can* run sessions as the same agent, but at most
one session may act in a room and the newcomer always wins. One process, one
host.

**6. Nothing records which human drove it.** For incident response that
matters, because the postmortem's second question is always "who did what,
when". G15.

### Roles, correctly scoped

- **In the hub: an alias, not a role,** while there is one agent.
- **In a war room: no role held by the shared agent.** A role lease is unique
  per *agent*, globally (G16). `scribe` is defined in each war room and assigned
  to nobody, there for a responder's own coding agent to pick up.
- **Humans cannot hold roles at all,** so "incident commander" is a human
  convention written into the room's instructions (G17).

### The recommendation

**The destination:** one shared responder agent per product. Owned by a
dedicated non-admin service user. Running `auto_session` on shared, always-on
infrastructure, with a supervised sidecar and the PagerDuty connector
installed. Addressed by the alias `responder`. Open addressing policy. Never run
from an engineer's machine.

**Acceptable now,** and what the team has done: reuse an existing shared agent
that meets every line except ownership, on the conditions in
[The agent the team chose](#the-agent-the-team-chose).

| Setting | Value | Why |
| --- | --- | --- |
| `name` | `<product>-responder` | The routing key. No person in it. |
| owner | a dedicated service user, **not** an admin | The agent inherits its owner's permissions exactly. |
| `connection_model` | `auto_session` | Comes online when addressed. |
| host | one always-on machine, PagerDuty connector installed | Online regardless of whose turn it is; one place to configure the integration. |
| sidecar | installed as a service | The agent is on the paging path; a reboot must not silence it. |
| credential | one copy, on that host | Cannot be revoked per holder, so do not spread it. |
| PagerDuty identity | a dedicated PagerDuty user | Declarations read as the agent's, not a person's. |
| addressing policy | open | A rotation cannot be enumerated, and an alerting tool's mention is refused under any restricted policy. |
| handle | alias `responder`, in the hub and every war room | Always wakes an on-demand agent. |
| procedure | a Switch document, not the host's `CLAUDE.md` | Follows the rooms; does not leak into its other work. |
| scope | five jobs, the rest named as out | The agent can do the on-caller's other jobs, and must not. |
| usage budget | none covering it | A budget that is reached stops the agent, and nothing exempts an on-call one. |

### The rule that makes it safe

Because nothing records which human drove the agent, the room transcript has to
carry the attribution instead:

> **The responder takes no consequential action that is not on the record in
> the room.** Either a person asked for it in writing, or it is one of the
> alert process's own steps, triggered by the alert above it: the triage note,
> the ping, the critical declaration, and the declaration when on-call did not
> respond in hours. Everything else it does is a read, or a draft posted back
> for a person to act on. It never posts to the stakeholder channel, never
> writes to PagerDuty beyond declaring, and never runs anything against
> production.

Under that rule the room *is* the audit log. Relax it and G15 becomes a real
hole.

## Gaps

Thirty-one, one of them now closed, grouped by what they block. Each says what is missing, why it matters
here, and a ticket to file. Sizes are rough: **S** is days, **M** is a sprint,
**L** is a project. The numbers are stable identifiers, not an ordering.

### A. Knowing who is on call — mostly closed

Switch has no rotation, schedule or concept of duty, and it should not acquire
one. The agent asks PagerDuty, and pings a Slack group a sync service keeps in
step. What remains is smaller, and one part of it is now on the paging path:

**G1 — There is no identity mapping across systems, and it is load-bearing.**
PagerDuty knows a person by name and email; the bridge knows them by a platform
handle. So the on-call *lookup* does not become an on-call *invite*, and, under
the alert process, the agent cannot reliably tell that a reply in the alert's
thread came from the on-caller. An unmatched name counts as not the on-caller,
which errs towards paging. And a name that cannot be invited is returned as
unresolved rather than raising, so a war room quietly comes up short unless the
caller inspects the result.

> **Proposed ticket:** *Surface unresolved invitees as a first-class result.*
> **S**

> **Proposed ticket:** *Cross-system identity mapping* — a per-bridge map from an
> external identity (email, or a third-party user id) to a Switch user and its
> platform handle, available to agents, so an agent holding a PagerDuty user can
> invite and recognise the person. Until it exists the mapping is a
> hand-maintained table in the hub's bindings. **M**

> **Proposed ticket:** *Invite a platform user group's members* — let room
> creation and `add_users_to_room` take a Slack user group. Where a sync service
> keeps the on-call group current, this makes "invite the on-call engineers" one
> step with no mapping. **S**

### B. The template format

**G2 — An agent cannot read the template registry. Closed.** Agents can now
list, read, run and save workspace templates. The war-room template is run from
the registry, and the document copy is gone.

**G3 — The gateway dashboard cannot supply parameter inputs.** The Console's
template screen renders `params:` as a form; the gateway's create-from-YAML page
posts raw YAML with no `inputs`.

> **Proposed ticket:** *Parameter form in the gateway*, or retire that page in
> favour of the Console's. **S**

**G4 — A parameter cannot hold a list.** Types are `string`, `number`,
`boolean`, `enum` and the entity types. `agents:` and `users:` are lists, so
membership cannot be parameterised.

> **Proposed ticket:** *List-typed template parameters.* **M**

**G9 — A room template is strictly less capable than the room creation it
wraps.** A template still cannot join an existing group, link to a room outside
the document, set `join_event_listeners` or `package_ids`, or attach an existing
library document. The agent covers three with follow-up calls; the group has no
cover.

> **Proposed ticket:** *Pass the remaining room fields through the template
> provisioner.* **S**

**G10 — Omitting `bridge:` silently means "the default bridge".** The war-room
template names its bridge explicitly, so it is not exposed, but a template
author who trusts the field's comment publishes a room they meant to keep
internal.

> **Proposed ticket:** *Fix the `bridge:` comment, and add an explicit
> `internal_only:` key.* **S**

**A hazard, not a gap.** A `{word}` no parameter declares is left verbatim, so a
typo in a placeholder name ships into the created room. Lint before
registering.

### C. Driving the flow

**G5 — No channel command declares an incident.** The on-caller addresses the
agent in prose ("@responder incident sev0 — …"), which works but is less
discoverable than a command.

> **Proposed ticket:** *`!declare-incident` in-room command.* **M**

**G6 — There is no generic alert ingress.** No endpoint accepts a third-party
alert payload and maps it to a Switch action. Alerts reach the agent as Slack
mentions.

> **Proposed ticket:** *Incident intake webhook.* **L**

**G7 — There is no scheduling primitive a *room* can use.** The response window
and the update clock both run on the agent host's scheduler. That **shares a
failure mode with the agent**: a host restart or a crashed session takes the
clock with it, silently. Under the alert process this is no longer about late
situation reports: a response check that never runs means an unanswered alert
that never pages. It is also invisible to the room: nobody can see that a check
is scheduled, confirm it, or cancel it.

> **Proposed ticket:** *Scheduled room actions* — a room-scoped trigger (one-shot
> or recurring) that posts a message or addresses an agent, created with the
> room or the alert thread and disposed of with it, visible to everyone in the
> room, and kept somewhere that does not go down with the agent. **L**

**G8 — There is no relay between rooms.** Posting requires connecting, and a
session that connects to another room evicts the agent's own session there. So
the hub session relays war-room milestones by reading on a timer, and people post
situation reports to both channels.

> **Proposed ticket:** *Mirror a message to a linked room.* **M**

### D. The shared agent

**G11 — There is no provisionable service account.** The recommendation rests
on owning the responder with a non-person, non-admin user. **This is the gap the
responder design depends on.**

> **Proposed ticket:** *Service accounts.* **M**

> **Proposed ticket:** *Transfer agent ownership.* **S**

**G12 — The gateway's addressing-policy editor drops owner rules.**

> **Proposed ticket:** *Preserve symbolic rules in the gateway policy editor*,
> and warn when a saved policy admits nobody. **S**

**G13 — The offline nudge names the owner, not whoever can act.**

> **Proposed ticket:** *Escalation target for an offline shared agent.* **S**

**G14 — One credential per agent; no rotation, no per-holder revocation.**

> **Proposed ticket:** *Per-holder agent credentials.* **M**

**G15 — Nothing records which human drove a session.** Mitigated here by the
rule that the agent acts only on the record, and conventions are not
enforcement.

> **Proposed ticket:** *Record the operator behind a session.* **M**

**G16 — A role lease is held per agent, globally.**

> **Proposed ticket:** *Scope a role lease to (agent, room).* **M**

**G17 — Role eligibility is declared and unused; humans cannot hold roles.**

> **Proposed ticket:** *Enforce role eligibility.* **S**

> **Proposed ticket:** *Human-holdable roles.* **L**

**G31 — A usage budget can silence an on-call agent.** Once an agent reaches
a budget covering it, Switch refuses messages addressed to it and its own
posts until the period resets. A workspace-wide budget covers every agent, and
there is no way to exempt one. Usage is counted after the fact, so the stop
lands on the next piece of work, which for a responder may be the alert that
mattered. Switch does post a notice when it refuses, which keeps it visible.

> **Proposed ticket:** *Budget exemptions and warnings for agents on a paging
> path* — let a budget exclude named agents (or let an agent be marked as
> exempt from workspace-wide budgets), and warn the room and the workspace's
> admins at a threshold before a budget stops an agent. **S**

**G30 — A role mention does not wake an on-demand agent.** A role held by an
`auto_session` agent routes to nobody whenever that agent is idle. The design
sidesteps it with an alias, which gives up the role's failover.

> **Proposed ticket:** *Wake a role's agent when no one holds it.* **M**

### E. Third-party capability

**G19 — MCP is per-machine, not per-agent.** Giving the responder a PagerDuty
connector gives it to every agent on that host, and the alert process means it
is now a connector with write access. Workable, by running the responder on its
own host, but it is why "give this one agent a tool" is a machine-provisioning
task, and why the PagerDuty write boundary is prose.

> **Proposed ticket:** *Per-agent MCP servers.* **L**

**G27 — On-call tooling has no built-in reference type.** A `pagerduty` type is
a setup step every deployment repeats, and a block of prose each one can edit.
It matters more now: the type's instructions are where the write boundary lives
("declare, never acknowledge or resolve"), and the tool surface will not
enforce it.

> **Proposed ticket:** *Built-in reference types for on-call and observability
> tooling* — `pagerduty` first, with a test pinning the write-boundary wording.
> **S**

**G20 — There is no agent-scoped secret storage.** A PagerDuty token with write
access lives in the host environment, shared across every agent there.

> **Proposed ticket:** *Agent-scoped third-party credentials.* **M**

### F. Fidelity of delivery

**G21 — A third-party app's message reaches Switch lossily, and its edits not
at all.** The alert process makes this load-bearing: the agent must triage what
fired, and an alert whose mention lands in the plain text arrives with its
detail stripped. The design copes only where the host has a connector to look
the alert up with.

> **Proposed ticket:** *Extend Block Kit extraction.* **S**

> **Proposed ticket:** *Bridge message edits.* **M**

**G28 — An agent cannot opt in to unaddressed messages.** "Observe all alerts"
is met by putting the agent's group in every monitor's message: a Switch
concern spread into the alerting tool's configuration. `room_join` events
already solve the same problem with a per-room, per-agent opt-in.

> **Proposed ticket:** *Per-room message listeners.* **M**

**G29 — An agent cannot notify a Slack user group, except by writing raw
markup.** The workaround works only because an agent's text is not escaped on
the way out, and the same omission lets any agent write `<!channel>`.

> **Proposed ticket:** *Outbound user-group mentions, and a rule for raw
> markup.* **S**

**G23 — Nothing detects a host that cannot receive pushed events.**

> **Proposed ticket:** *Detect a session that cannot receive events.* **S**

### G. Where the agent runs

**G22 — A remote agent does not survive a host reboot.** Every other gap here
degrades a feature. This one makes the responder absent: alerts nobody was told
about, and unanswered alerts that never page.

> **Proposed ticket:** *Supervise the remote sidecar* — install it as a user
> service so a host reboot brings it back, and surface "host up, sidecar down"
> as a distinct state. **M**

**G24 — A remote host is one person's record, not a team resource.**

> **Proposed ticket:** *Server-side host records.* **L**

> **Proposed interim:** document the shared-host convention and the adoption
> path. **S**

**G25 — Nothing provisions an agent host.**

> **Proposed ticket:** *A reference agent host.* **M**

**G26 — The only host-free option has no tool mediation.**

> **Proposed ticket:** *Mediation for server-side connector agents.* **M**

### H. Closing the incident out

**G18 — There is no transcript export.** The responder can page back through the
room and post a timeline as an attachment, which is good enough.

> **Proposed ticket:** *Export a room transcript.* **S**

## What to build first

**Nothing, to run it. Two things, before anyone depends on it.**

The on-call manual runs on Switch today with no change to Switch:

- The war room is built from a registered template, by an agent calling
  `run_template`.
- PagerDuty is reached the way Jira already is, with write access for declaring.
- Every alert wakes the agent because every monitor mentions its group.
- The agent notifies on-call by writing the group's raw tag.
- The response window and the update clock run on the agent host's scheduler.

Standing it up is configuration: one template, two documents, and a few lines in
the alerting tool. The deploy guide in the instruction set is the checklist.

Six compromises in that, worth naming out loud rather than discovering:

- **Identity.** The agent is admin-owned. Until G11 exists, neither that nor a
  personal owner is right.
- **Host.** The machine is the team's by convention only (G24, G25).
- **Availability.** A reboot takes the responder offline until someone notices
  (G22), and a crashed session takes its clocks with it (G7). The agent is now on
  the paging path, so either means an unanswered alert that never pages.
- **Budgets.** If the workspace sets usage budgets, reaching one stops the
  responder, and nothing exempts it (G31).
- **The write boundary is prose.** The agent's PagerDuty connector can resolve
  as easily as it can declare, and so can every other agent on its host (G19,
  G27).
- **Two workarounds that work by omission.** The ping relies on the bridge not
  escaping an agent's text (G29). Seeing alerts relies on every monitor carrying
  the agent's group, while Switch drops most of what those monitors say (G28,
  G21).

**Then, in order of value per unit of work:**

1. **G22 — supervise the remote sidecar.** The agent is on the paging path.
2. **G7 — scheduled room actions.** Moved up from tenth: the response window
   decides whether anyone is paged, and it should not die with the agent.
   Large, so start the design now; the renotify and start-of-shift backstops
   carry it until then.
3. **G31 — budget exemptions and warnings.** Small, and on the paging path:
   until it exists, the deploy guide's answer is "no budget covers the
   responder".
4. **G29 — outbound user-group mentions, and a rule for raw markup.** Small.
   Turns the ping from an accident into a contract.
5. **G21 — extend what Switch keeps of an app's post.** Small. The agent stops
   depending on a connector to find out what fired.
6. **G11 — a service account.** The ownership compromise ends here.
7. **G1 — cross-system identity mapping.** The response check depends on
   recognising the on-caller.
8. **G27 — a built-in `pagerduty` reference type.** Small. Puts the write
   boundary under code review.
9. **G28 — per-room message listeners.** Moves "observe all alerts" from the
   alerting tool into one setting per room.
10. **G30 — wake a role's agent when no one holds it.** Gives the responder
    failover back.
11. **G23 — detect a session that cannot receive events.** Small.
12. **G9 — the remaining room fields in templates.**
13. **G8 — mirror to a linked room.**
14. **G25, then G24.** Together they turn "we run a responder" from a favour
    someone is doing into infrastructure.
15. Everything else, as it starts to hurt.

The honest summary: **the design needs no Switch changes to run. Before anyone
should depend on it, it needs one operational fix (a supervised sidecar), one
setting (no usage budget covering the responder), and one piece of design work
started (a clock that does not die with the agent).**
Neither is specific to incident response. The same gaps will surface for every
shared agent that sits on a path someone depends on.
