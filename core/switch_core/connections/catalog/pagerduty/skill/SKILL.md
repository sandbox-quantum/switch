---
name: pagerduty
description: Work with PagerDuty incidents, services, schedules and on-calls through its MCP tools, acting with the owner's PagerDuty access.
---

# PagerDuty

The `pagerduty` MCP server gives you PagerDuty's own tools for incidents,
services, schedules, on-calls, teams and escalation policies. You act as the
owner of this connection, with whatever their PagerDuty access allows.

How to work with it:

- Start by reading. Find the incident, service or schedule and look at its
  current state before you change anything. Quote what you found: the incident
  or service, and a link to the PagerDuty page, so a person can check it.
- During an incident, on-call people are under pressure. Keep notes and updates
  short and factual, and say which incident they belong to.
- Change incidents, services, schedules or overrides only when you were asked
  to, and say what you changed. Paging someone, reassigning an incident or
  editing a schedule affects real people's night, so confirm the target before
  you act.
- Production and on-call data can include personal information. Summarise
  rather than copying raw details into rooms, and never post secrets.

If a tool answers that the request is not allowed, the connection's access does
not cover it (some actions and filters need a user-level key): say so rather
than trying another way.
