# Connections (v1)

A connection gives a user's cloud agents access to an external service. Each
connection comes with a skill: instructions, installed on the agent's VM, for
using the service. v1 has a catalog and a grid in the Console. GitHub is the
only connection that works; every other service in the catalog is shown as
"Coming soon".

## Decisions

- **Owner.** A connection belongs to the user and can be granted to many of
  their agents.
- **Catalog.** Built in only. It ships with Core; admins cannot add entries or
  upload skills.
- **Accounts.** One account per service per user.
- **Scope.** Cloud agents only. Local agents started by the Console get no
  connection skills.
- **CLIs.** Baked into the VM image (`gh` today). Nothing is downloaded at
  boot.
- **GitHub stays required** for a cloud launch, since the workspace is a
  GitHub repository. Every cloud launch is therefore granted the GitHub
  connection. Claude Code, Codex and OpenCode agents also get its skill.
  Cursor and Antigravity agents get no connection skills, because they have
  no skills directory.

## Catalog

One directory per service under `core/switch_core/connections/catalog/`:

```
catalog/<slug>/
  connection.yaml   # required
  skill/            # required when enabled, forbidden when not
    SKILL.md
    ...             # optional extra files, e.g. references or scripts
```

`connection.yaml` has exactly these fields:

```yaml
slug: github                # must equal the directory name
name: GitHub
category: Source control
description: Clone, branch, push and open pull requests in the repository you grant.
enabled: true               # false = "Coming soon" placeholder
auth:
  type: oauth               # oauth | api_key
```

There are no logos; the Console draws a monogram from the name.

`core/switch_core/connections/loader.py` validates the whole catalog when
Core imports it, so a malformed entry stops Core from starting. The loader
rejects:

- unknown keys, a slug that does not match its directory, or an unknown auth
  type;
- any file in an entry other than `connection.yaml` and `skill/`;
- an enabled entry without a skill, or a placeholder that ships one;
- a skill without `SKILL.md`, or whose `SKILL.md` frontmatter is missing
  `name: <slug>` or a `description`;
- symlinks, unsafe paths, non-UTF-8 or NUL content, and skills larger than
  32 KiB.

v1 entries:

| Category | Services |
|---|---|
| Source control | GitHub (enabled), GitLab, Bitbucket |
| Project management | Jira, Asana, Linear |
| Knowledge base | Notion |
| Productivity | Google Workspace, Microsoft 365 |
| File storage | Box |
| Observability | Datadog, New Relic |
| CRM | Salesforce |
| Design | Canva |
| Deployment | Vercel |

## API

`GET /provider-connections/catalog` (gateway, authenticated) returns the
catalog along with the caller's status for each entry:

```json
{"connections": [{"slug": "github", "name": "GitHub", "category": "Source control",
  "description": "...", "enabled": true, "auth_type": "oauth",
  "status": "connected"}]}
```

`status` is `coming_soon` for a placeholder. For an enabled entry it is
`connected` if the caller has a row in `provider_connections` for that slug,
and `not_connected` otherwise. Connecting and disconnecting GitHub still use
the existing GitHub endpoints.

## Skill delivery

The skills travel inside the launch's deployment document, next to the other
launch data:

```json
"skills": [{"slug": "github", "files": {"SKILL.md": "..."}}]
```

1. **Core** (`/hosted-controller/{id}/prepare`) adds `skills` for the
   connections granted to the launch. A provider that has no skills directory
   (Cursor, Antigravity) gets an empty list, and Core logs a warning.
2. **The controller** copies `skills` into the deployment only when it is
   non-empty, so a Core that predates skills produces the same deployment as
   before.
3. **The worker** (root) validates `skills` strictly: at most 16 skills,
   unique and well-formed slugs, `SKILL.md` required, relative paths with no
   empty, `.` or `..` segment, no NUL, and 32 KiB in total. It writes nothing
   into the agent-owned state disk, because a root process writing into a
   directory the agent controls could be sent elsewhere through a symlink.
4. **Bootstrap** (runs as the agent) applies the same limits. It refuses skills
   for a provider that has no skills directory. Before it starts the worker,
   on every start, it replaces each skill in the provider's skills directory,
   writing to a temporary directory first and then renaming it into place:

   | Provider | Directory |
   |---|---|
   | Claude Code | `$CLAUDE_CONFIG_DIR/skills/<slug>/` |
   | Codex | `$CODEX_HOME/skills/<slug>/`, linked into each session's home |
   | OpenCode | `$XDG_CONFIG_HOME/opencode/skills/<slug>/` |

`skills` is optional in every layer, so deployments without it keep working.

## Rollout

The worker rejects a deployment key it does not know. A worker built before
this change therefore rejects a deployment that carries `skills`, and the
launch fails. That happens when a new Core and a new controller send skills
to a worker on an older VM image.

- Roll out the new VM image before, or together with, the new Core and
  controller. A worker must accept `skills` before any launch carries them.
- Existing workers pick up the new image only when they are replaced. Until
  then, do not deploy a Core and controller that send skills to them.
- Images and a VM image built before this change cannot validate skill
  delivery. Validate it on a build that contains the whole change: Core,
  controller, worker and bootstrap.

## Console

In the cloud onboarding flow, the step that used to connect GitHub directly
is now a Connections grid:

- a search box that matches name or category, ignoring case;
- one card per entry, showing the monogram, name, category and a status
  badge; enabled entries are listed first;
- the GitHub card opens the existing GitHub connection step, and going back
  returns to the grid and refreshes it;
- placeholder cards are disabled and marked "Coming soon";
- "Continue to agent" appears once GitHub is connected.

The renderer gets the catalog through `rpc.switchServers.getConnectionCatalog`,
which calls the gateway from the main process.

## Not in v1

- Choosing, per launch, which connections an agent gets. Today GitHub is
  always granted.
- Other services: their auth flows, credential storage and delivery
  (credential files, environment wrappers), and "Test connection" checks.
- Custom catalog entries, and more than one account per service.
- Connection skills for local agents.
