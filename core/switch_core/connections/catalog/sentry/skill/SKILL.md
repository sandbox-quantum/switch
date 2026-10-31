---
name: sentry
description: Inspect and manage production errors, stack traces, issues, events and releases in Sentry acting with your owner's Sentry access.
---

# Sentry

The `sentry` MCP server gives you tools to inspect errors, crashes, and performance issues in Sentry. Use them to investigate production defects, retrieve stack traces, identify offending releases, and locate affected users.

## How to work with it:

- **Start narrow:** Always scope queries by project (`projectSlug`), organization (`organizationSlug`), environment, or time range. Unbounded searches across large organizations are slow and hit rate limits.
- **Inspect before changing:** Read issue details, stack traces, and tags before taking actions. Do not mutate issues (such as resolving, assigning, or archiving) unless explicitly requested by the user.
- **Quote context and links:** When summarizing errors or events, cite the issue ID, exception type, error message, culprit file or function, and direct URL to the Sentry issue so team members can verify your findings.
- **Respect data privacy:** Stack traces, error tags, and request breadcrumbs may contain sensitive customer or internal environment information. Summarize error traces concisely and never copy unneeded personal data or secrets into conversation rooms.

## Finding things:

- `search_issues` and `get_issue_details` find grouped issues and fetch their context, frequency, and first/last seen timestamps.
- `search_events` and `get_event_details` retrieve raw event payloads, breadcrumbs, and device/browser contexts.
- `find_projects` and `find_releases` identify available projects and deployed application releases.
- `find_monitors` and `find_alert_rules` inspect scheduled job monitors and alerting configuration.

If a tool reports that access is not allowed or that permissions are insufficient, the connection does not cover the action: explain the restriction clearly rather than attempting workarounds.
