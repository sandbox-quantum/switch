---
name: new-relic
description: Investigate production performance, NRQL queries, entities, alerts and system metrics with New Relic MCP tools, acting with the owner's New Relic access.
---

# New Relic

The `new-relic` MCP server gives you New Relic's observability and telemetry
tools. Use them to run NRQL queries, inspect entity health, look up alert
violations, and check system performance metrics.

How to work with it:

- Start narrow. Specify account IDs, entity GUIDs, or narrow NRQL time windows
  (`SINCE 1 hour ago`, `LIMIT 50`) rather than running broad unbounded queries.
- Quote what you find: include entity names, alert condition titles, NRQL queries
  executed, and links to New Relic dashboards or entity views so responders
  can verify findings.
- You act as the owner of this connection, with whatever their New Relic permissions
  permit.
- Confirm with the user before modifying alert policies, acknowledging or
  closing incidents, or creating entities unless explicitly instructed to do so.
- Note that AI preview and assistant tools require OAuth and are unavailable
  on User key connections.
- Production telemetry and query results may include customer metadata or
  system details. Summarize context clearly, redact private data before sharing
  in rooms, and never share secrets.

If a tool answers that an action is not permitted, the connection's permissions
do not cover it: inform the user rather than searching for alternative paths.
