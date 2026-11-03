---
name: sentry
description: Investigate production errors, exceptions, stack traces, releases and crash reports with Sentry MCP tools, acting with the owner's Sentry access.
---

# Sentry

The `sentry` MCP server gives you Sentry's application monitoring and debugging
tools. Use them to investigate production errors, search issues, inspect stack
traces, examine breadcrumbs, and track releases.

How to work with it:

- Start narrow. Specify issue IDs, project slugs, environments, or specific
  timeframes before querying events or exceptions. Unfiltered queries are slow
  and risk hitting rate limits.
- Quote what you find: include issue IDs, stack traces, offending filenames,
  line numbers, and links to the Sentry event page so developers can verify
  the diagnosis.
- You act as the owner of this connection, with whatever their Sentry permissions
  permit.
- Confirm with the user before resolving, assigning, muting, or updating
  the status of any issue unless specifically instructed to do so.
- Production error reports and breadcrumbs may include sensitive user or
  system details. Summarize context clearly, redact private data before sharing
  in rooms, and never share secrets or sensitive credentials.

If a tool answers that an action is not permitted, the connection's permissions
do not cover it: inform the user rather than searching for alternative paths.
