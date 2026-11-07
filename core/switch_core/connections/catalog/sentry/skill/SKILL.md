---
name: sentry
description: Look up Sentry issues, events, stack traces and releases through the Sentry connection your owner granted this agent. Load before inspecting production errors or crashes.
---

# Sentry

Your owner granted this agent their Sentry connection. Its tools are on the `sentry` MCP server.

## What the grant reaches

- You act as your owner. Everything read or inspected reflects their account permissions in Sentry.
- Read operations reach Sentry issues, events, breadcrumbs, tags and releases.
- If a tool is refused, explain the restriction clearly to the user rather than searching for workarounds.

## Usage guidelines

- Scope queries by organization, project, environment, or time range to avoid broad searches and rate limits.
- Inspect issue stack traces, culprit functions and error tags before making deductions.
- Confirm with the user before modifying issue states (such as resolving, assigning or ignoring).
- Stack traces and breadcrumbs may contain sensitive internal data; summarize error context concisely.
