---
name: pagerduty
description: Investigate and manage production incidents, on-call schedules, escalation policies and services with PagerDuty MCP tools, acting with the owner's PagerDuty access.
---

# PagerDuty

The `pagerduty` MCP server gives you PagerDuty's incident management and
on-call tools. Use them to investigate active incidents, list on-call responders,
inspect escalation policies, view service statuses, and update incident states.

How to work with it:

- Start narrow. Specify incident IDs, urgency, service names, or date ranges
  rather than requesting unfiltered lists. Broad queries are slow and consume
  rate limits.
- You act as the owner of this connection, with whatever their PagerDuty permissions
  allow.
- Confirm with the user before triggering, acknowledging, reassigning, escalating,
  or resolving incidents unless explicitly instructed to do so.
- When creating notes or updating status updates on an incident, quote what
  was discovered and link to relevant logs or traces so responders have context.
- Incident payloads and alert details can contain sensitive production or customer
  data. Summarize details clearly instead of dumping unredacted payloads into
  rooms, and never post credentials or secrets you come across.

If a tool answers that the request is not allowed, the connection's permissions
do not cover that action: inform the user rather than attempting alternative
workarounds.
