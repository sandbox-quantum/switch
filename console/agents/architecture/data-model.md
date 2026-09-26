# Data Model (Switch Console vs. its upstream origin)

Switch Console inherited its data model from the upstream project it was forked from
(attribution in `NOTICE`), which is optimised for **parallel coding workflows**: a
project (repo) holds several sessions (originally one per git worktree), each session
holds conversations with a coding agent and one or more terminals, all running in an
abstracted *workspace* (worktree / SSH / remote).

Switch Console manages **Switch agent sessions** instead: multiple agents living in a
directory, each tied to one provider, each with its own runs. This page is the system
of record for how the Switch Console model diverges from that upstream model and how the
abstractions map across.

The schema is defined in `apps/switch-console-desktop/src/main/db/schema.ts`.

## Abstraction map

| Switch Console | upstream equivalent | What it is |
|---|---|---|
| **location** | `project` + `workspace` | A working directory on a host — local, or on an SSH host. Replaces both the upstream project *and* the workspace abstraction; the table is `locations`. |
| **agent** | *(none)* — new | A Switch agent identity bound to one provider. **Many agents per directory.** Carries the optional Switch identity (`switchAgentId`, `apiEndpoint`) detected from `.claude/settings.local.json`. |
| **provider** | `agent` | The CLI agent kind (claude, codex, antigravity, …). Upstream called this an "agent"; here it's a *provider*, referenced by an agent via `providerId`. It stays a static code registry, not a table. |
| **session** | `conversation` | One instantiation/run of an agent. The unit shown under an agent in the sidebar. |
| **message** | `message` | A message in a session (was keyed by `conversationId`, now `sessionId`). |
| *(removed)* | `session` (worktree-era) | The upstream parallel-run grouping. Removed — Switch Console runs every session in the location's directory, so the grouping layer is gone. |
| *(removed)* | `workspace` | The upstream execution-location abstraction (worktree / SSH / BYOI remote). Removed — see below. Switch Console has a `workspaces` table again, but it names something unrelated: a tenant on a Switch server. |
| **workspace** | *(none)* — new | A tenant on a Switch server, and what the window is scoped to. An agent belongs to one; every gateway call is made in its name. The table is `workspaces`. |

### Tables with no upstream equivalent

These carry the Switch- and remote-specific state that upstream had no concept of:

| Table | What it is |
|---|---|
| `switch_servers` | A Switch server Switch Console talks to, managed or external. |
| `workspaces` | A tenant on one of those servers. Registering a server creates its first, tenant-less and named after the server. Agents reference it, and the active selection (`kv`, `activeWorkspaceId`) names one. |
| `remote_hosts` | An SSH host (keyed by its `~/.ssh/config` alias) that can run agents. |
| `remote_host_reachability` | The last observed reachability of a host. Separate from the host record so a probe result never masquerades as configuration — see the reachability note below. |
| `remote_host_setup_plans` | A host's onboarding plan (CHOO-1809). See "Remote host setup". |
| `location_settings` | Per-location DB-backed settings (distinct from `.switchdash.json`). |
| `session_room_connections` | The Switch room a session is attending (0..1). |
| `kv`, `app_secrets` | Generic key/value state and encrypted secrets. |

## Resulting hierarchy

```
location  (a working directory, local or on an SSH host)
  └─ agent     (Switch identity; one provider each; many per location)
       └─ session   (a run/instantiation; was "conversation")
            ├─ message
            └─ session_room_connection   (0..1 — the Switch room it is attending)
```

A location that lives on an SSH host references a `remote_hosts` row; that host carries
its own reachability and setup-plan rows alongside, not inside, the location hierarchy.

An agent also references the workspace it belongs to, which is not part of this
hierarchy: a location is where an agent runs, a workspace is who it runs as. One
directory can hold agents belonging to different workspaces, and a workspace's
agents can be spread across directories and hosts.

A session's room connection is a row keyed by `session_id` with
`ON DELETE CASCADE`, so it cannot outlive the session (or the agent above it).
It was previously a JSON blob in `app_settings`, which referenced nothing and so
survived both — leaving Switch Console restoring sessions, on every launch, for
agents whose Switch server had been destroyed.

## What we deliberately dropped from upstream, and why

- **The upstream workspace abstraction.** (Not to be confused with Switch
  Console's own `workspaces` table above, which reuses the name for a tenant on
  a Switch server and has nothing to do with this.) Upstream modelled
  *where* a session runs (git worktree, project-SSH, BYOI remote). Switch Console had
  already gutted this before the rework — `workspace-config` reached v3 with the
  note *"Switch Console has no git worktrees, branches, PRs, or BYOI: every session
  runs in the project root directory."* A workspace was therefore just "the
  project directory" plus lifecycle scripts. We dropped it (and
  `project.repositoryWorkspaceId` / `session.workspaceId`) and keep lifecycle
  scripts / fs access as a service hung off the location's directory.

  **What survived of it is the host split, not the table.** "Where a session runs" is
  still a real question — it is now answered by the location's host (local or SSH) and
  by the `execution-context` / `agent-runtime` provider pairs, rather than by a
  `workspace` row. Dropping the table did not make Switch Console local-only.
- **The worktree-era `session` grouping.** With no worktrees, a session was a
  near-empty wrapper around a single conversation. We collapsed it: the upstream
  `conversation` becomes Switch Console's `session`.
- **The `terminals` table and terminal sessions.** Every session is an SDK
  conversation. The legacy `sessions.shell_id` column was dropped in migration
  0050; there is no session kind, so a session created by a terminal-era build
  is simply resumed through the SDK host like any other.
- **`provider` as a per-session column.** A provider is a property of the agent
  (an agent is from one provider), so it moved up from the session onto the
  agent.

## Naming note (code)

This rename has **landed**. The upstream "agent" concept (the provider registry and its
tooling) is now `providers/` in both `src/main/core/` and `src/shared/core/`, and the name
**agent** belongs to the Switch-agent concept. The Switch-agent domain absorbed the former
`switch-agents/detect.ts` directory detector, which is now `core/agents/detect.ts`.

So in current code:

- `core/agents/` — Switch agents (create, onboard, detect, remote discovery)
- `core/providers/` — the CLI-provider registry, payload builder, plugin registry

Both directories exist and mean different things. `core/switch-agents/` no longer exists.
