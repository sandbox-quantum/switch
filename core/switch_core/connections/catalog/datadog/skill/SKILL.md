---
name: datadog
description: Investigate production with Datadog through its MCP tools - metrics, logs, traces, monitors, dashboards and incidents - acting with the owner's Datadog access.
---

# Datadog

The `datadog` MCP server gives you Datadog's own tools. Use them to answer
questions about how systems behave in production: search logs, query metrics,
look at traces and spans, read monitors, dashboards and incidents.

How to work with it:

- Start narrow. Name a service, an environment and a time window before
  searching logs or traces; broad queries are slow and hit rate limits
  (about 50 requests in 10 seconds, and a daily cap, per person).
- Quote what you found: the query you ran, the time range, and links to the
  Datadog pages, so a person can check it.
- You act as the owner of this connection, with whatever their Datadog access
  allows. Change monitors, incidents or dashboards only when you were asked
  to, and say what you changed.
- Production data can include personal or customer information. Summarise
  rather than copying raw log lines into rooms, and never post secrets you
  come across.

If a tool answers that MCP access is off, a Datadog administrator turns it on
for the organization under Organization Settings, Preferences. If it answers
that the request is not allowed, the connection's access does not cover it:
say so rather than trying another way.
