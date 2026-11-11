---
name: sentry
description: Inspect errors, stack traces, and triage issues in Sentry acting with your owner's Sentry access.
---

# Sentry

The `sentry` MCP server gives you tools to inspect errors, crashes, performance issues, and triage defects in Sentry. Use them to investigate production defects, retrieve stack traces, identify offending releases, and update issue statuses.

## What this connection can change:

- **Triage operations:** Tools permit updating issue statuses (e.g. resolving, unresolving, ignoring) and assigning issues to team members.
- **Inspect before changing:** Always inspect issue details, frequency, and stack traces before making changes. Never mutate an issue (resolving, assigning, or updating status) without explicit confirmation from the user in the room.

## How to work with it:

- **Start narrow:** Always scope queries by project (`projectSlug`), organization (`organizationSlug`), environment, or time range. Unbounded searches across large organizations are slow and hit rate limits.
- **Quote context and links:** When summarizing errors or events, cite the issue ID, exception type, error message, culprit file or function, and direct URL to the Sentry issue so team members can verify your findings.
- **Respect data privacy:** Stack traces, error tags, and request breadcrumbs may contain sensitive customer or internal environment information. Summarize error traces concisely and never copy unneeded personal data into conversation rooms.

## Finding things:

- `search_issues` and `get_issue_details` find grouped issues and fetch their context, frequency, and first/last seen timestamps.
- `search_events` and `get_event_details` retrieve raw event payloads, breadcrumbs, and device/browser contexts.
- `find_projects` and `find_releases` identify available projects and deployed application releases.
- `find_monitors` and `find_alert_rules` inspect scheduled job monitors and alerting configuration.

If a tool reports that access is not allowed or that permissions are insufficient, the connection does not cover the action: explain the restriction clearly rather than attempting workarounds.
