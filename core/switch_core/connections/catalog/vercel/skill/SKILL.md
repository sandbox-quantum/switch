---
name: vercel
description: How to inspect Vercel projects, deployments and deployment logs through the Vercel connection your owner granted this agent. Load before checking deployments, build logs, runtime logs or project details in Vercel.
---

# Vercel

Your owner granted this agent their Vercel connection. You reach it through one
tool, `vercel`, on the `vercel` MCP server. It runs Vercel's `vercel` command-line
tool for you; there is nothing to install, sign in to or renew.

## What the grant reaches

- **You act as your owner.** You see what they can see in Vercel across the
  projects and deployments their token permits.
- **Projects, deployments, and logs inspection only.** This connection is
  configured for read-mostly inspection. Creating or mutating deployments
  (`deploy`, `redeploy`, `rollback`, `promote`, `remove`), altering DNS/domains,
  or editing account and team settings are unavailable through this tool.
- When the tool says Switch removed the grant or the connection must be
  reconnected, your owner has to do that.
- Never print, log or store credentials.

## Calling the tool

Give `args` as the command line after `vercel`, one argument per item and never
quoted for a shell:

```json
{"args": ["list", "my-app", "--limit", "10"]}
```

- Allowed top-level commands are `list` (or `ls`), `inspect`, `logs`, and
  `project` (or `projects`).
- Add `--json` to `list`, `inspect`, or `logs` to receive structured
  JSON output suitable for parsing.
- Answers too long to return in the tool call are saved to a file, and the
  tool output indicates where.

## Common tasks

- **List projects:** `project list` displays all projects in the accessible scope.
- **Inspect a project:** `project inspect <name>` displays project details,
  framework presets, and repository links.
- **List deployments:** `list <project-name>` (or `list --all --limit 20`) shows
  recent deployments, their statuses, URLs, and environments.
- **Inspect a deployment:** `inspect <deployment-url-or-id>` shows summary
  details (status, author, build time, routes).
- **Inspect deployment build logs:** `inspect <deployment-url-or-id> --logs`
  fetches the build and compilation logs for troubleshooting failed builds.
- **View runtime logs:** `logs --deployment <deployment-id> --limit 100` displays
  runtime execution log records.
- **Filter runtime logs:** `logs --project <project-name> --query "level:error"`
  filters log output for errors.

## Investigating deployment failures

When debugging a deployment failure:
1. Identify the recent failed deployment using `list <project-name> --status ERROR`.
2. Retrieve the build logs with `inspect <deployment-url-or-id> --logs`.
3. If the build succeeded but the application fails at runtime, inspect runtime
   errors using `logs --deployment <deployment-url-or-id> --query "level:error"`.
4. Summarize errors clearly for the user rather than dumping raw log streams.
5. Production logs may contain private customer or sensitive data. Never post
   sensitive data, secrets, or environment variables into conversations.
