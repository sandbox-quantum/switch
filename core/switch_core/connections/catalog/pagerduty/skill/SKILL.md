---
name: pagerduty
description: Work with PagerDuty incidents, services, schedules and on-call through its MCP tools - see what is firing and who is on call, and acknowledge, resolve or annotate incidents when asked - acting with the owner's PagerDuty access.
---

# PagerDuty

The `pagerduty` MCP server gives you PagerDuty's own tools. The `browse_`
tools read; the `manage_` tools change things. Use them to answer what is
firing, what it affects, who is on call and what happened during an incident.

What this connection reaches:

- Reading: incidents (with their alerts, notes, timeline and related or past
  incidents), services and their alert grouping, schedules and on-call,
  escalation policies, teams, users, change events and the activity log. You
  see only what the owner can see in PagerDuty.
- Changing, where the owner granted write access: incidents only - create,
  acknowledge, resolve, reassign, and add notes or responders.
- Not available here: status pages, incident workflows, event orchestrations
  beyond a single service's, and changing services, schedules, teams or alert
  grouping. Those tools are listed but PagerDuty refuses them. Say so rather
  than trying another way.

How to work with it:

- Read before you change anything. Find the incident, its status, service and
  assignees first, and quote its number, title and link so a person can check.
- Acknowledge, resolve, reassign, escalate or create an incident only when a
  person in the room asked for that specific change, and confirm the incident
  number with them first. Each change notifies people and shows in PagerDuty
  as done by the owner of this connection. Say what you changed.
- Never resolve an incident to silence it. Resolving tells responders the
  problem is over.
- Prefer adding a note to changing state when you are unsure.
- Keep queries narrow: filter incidents by status, service, urgency or a time
  window rather than listing everything. Filtering by team or by who is
  assigned works because you act as a person.
- Incident details, alerts and notes can contain personal or customer
  information. Summarise rather than pasting raw payloads into rooms, and never
  post secrets you come across.

If a tool answers that the request is not allowed or lacks a scope, the
connection's access does not cover it: tell the person what it would take
(write access granted to the agent, or a PagerDuty role that allows it)
rather than trying another tool.
