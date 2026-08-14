# Engagements

A reusable way to stand up a **team** on Switch: a room network where each
engineer's Claude Code agent does the work and opens PRs, the engineer reviews
on GitHub, and everything is coordinated in Slack.

An **engagement** is a room group plus a set of rooms and the directed links
between them, declared in one YAML file and provisioned in a single command. It
builds on the single-room provisioning in `switch_core.rooms_yaml`.

The shipped preset — [`flintai-optimize-and-prove.yaml`](./flintai-optimize-and-prove.yaml)
— is both the concrete first instance for the "FlintAI Optimize and Prove" team
and the template you copy for the next team.

## The room network

Three hubs, filed under one room group, Slack-bridged:

- **Workforce Hub** — the front door. A manager agent discusses the work with
  the team, co-authors a design doc, breaks it into a Jira epic, and delegates
  each item to the Feature or Bug Hub.
- **Feature Hub** — turns each feature task into a dedicated child room +
  `feature-request/<slug>` branch, where a worker implements and opens a PR.
- **Bug Hub** — the same loop for bugs, on `bug-fix/<slug>` branches.

The lifecycle:

```
discuss goals ─▶ design doc ─▶ Jira epic ─▶ per-task room + branch + PR
              ─▶ human review on GitHub ─▶ address comments ─▶ team merge into main
```

Child rooms are **not** part of the preset — the manager creates them at runtime
as work arrives (one item = one room + branch + PR), and archives them on merge.

## Roles

Assumable, room-scoped instruction bundles:

- **design** (Workforce, exclusive) — reads the PRD + discussion, co-authors the
  design doc (a room document), sets technical direction. No code, no Jira.
- **planner** (Workforce, exclusive) — turns the design into a Jira epic +
  items and delegates each to a worker with a child room + branch.
- **worker** (Feature/Bug + child rooms, shared) — implements one task on its
  branch, opens a PR, addresses review comments. Never merges.

Modeling note: `design` and `planner` are roles worn by the manager agent, so a
team needs only one manager agent registered (plus one worker per member) rather
than separate design/task agents. If you prefer genuinely separate agents,
register them and add them to the Workforce Hub instead.

## Prerequisites

- A running **published Switch** instance, with **switchdash** on each operator's
  machine (it auto-starts a Claude Code session when an `auto_session` agent is
  addressed and no session is live).
- An **active Slack collaboration bridge** (`list_bridges` shows it; note its
  display name).
- The team members are **known to Switch on that Slack bridge** (each has
  messaged the workspace at least once), so they can be added by username.
- **GitHub access** for the worker agents: the operator/user grants `gh` +
  `git` push access in each agent's session so it can open PRs. (Switch does not
  hold these credentials; it is the user's responsibility to permit the agent.)
- A **Jira tool** in the manager agent's session (e.g. the Atlassian MCP) so the
  `planner` role can create the epic + items. Without it, the planner can draft
  the list and a human creates the issues.

## Provisioning

### 1. Register the agents

No agent is auto-created by the preset. Register them first (gateway UI →
Agents, or `POST /gateway/agents/register`), as `claude-code` known agents:

- **Manager agent** — e.g. `claude-code.flint-manager`, `auto_session=true`,
  `repo_dir` = the repo checkout, `channels_enabled=true`. It orchestrates all
  three hubs; give it the Jira tool + gh/git in its session.
- **One worker agent per team member** — e.g. `claude-code.flint-steven`,
  `auto_session=true`, `repo_dir` = that member's checkout, `channels_enabled=true`,
  with gh/git access.

The provisioner validates every agent name up front and fails loud on an unknown
one before creating anything — so register agents (or fix names) first.

### 2. Fill in the preset

Copy the preset for your team and edit the `ROSTER` / placeholder markers:

- `bridge:` on each room → your Slack bridge's display name.
- reference `value.urls` → the team's real GitHub repo and Jira project.
- the manager agent name (`claude-code.flint-manager`) → your registered manager
  (update the `agents`, `aliases`, and `join_event_listeners` entries together).
- under each hub, add one worker agent (`agents:`) and one Slack username
  (`users:`) per team member.

### 3. Provision

```bash
just provision-engagement deploy/engagements/flintai-optimize-and-prove.yaml
```

This logs into the gateway with the admin credentials from `.env`, then POSTs
the spec to `POST /gateway/engagements/from-yaml`. It:

1. validates all agent + bridge names (fail loud);
2. creates the room group;
3. creates each hub under the group (Slack channel, agents, users, roles,
   aliases, join-event listeners, references);
4. wires the hub-to-hub links.

Per-room attachment failures and link failures are returned in the response
(`rooms[].failed_attachments`, `failed_links`) rather than dropped — check the
output.

Override the gateway target with `SWITCH_GATEWAY_URL` (default
`http://localhost:${API_HOST_PORT}/gateway`). You can also POST the YAML to the
endpoint directly from any authenticated client.

## Running the workflow

1. In the **Workforce Hub**, the team discusses what needs to be done with the
   manager agent and agrees the goals.
2. The manager assumes **design**, co-authors the design doc (a room document in
   the hub), and gets sign-off.
3. The manager assumes **planner**, creates the Jira epic + items, and for each
   item spins out a child room + branch under the **Feature** or **Bug Hub** and
   assigns a worker.
4. In each child room, the worker implements the task and opens a PR against
   `main`. The reviewer reviews on GitHub and pings the worker to address
   comments; the worker pushes fixes to the same PR.
5. On approval, the rest of the team is invited to review + merge into `main`.
   The child room is archived and the merge reported back to the Workforce Hub.

## Adding / removing a team member

- **Add**: register a worker agent for them, then add their agent to the Feature
  and Bug hubs (`agents:` in the preset + re-provision, or `invite_agent_to_room`
  / `!invite-agent` in-room) and their Slack user to the hubs.
- **Remove**: remove their agent + user from the hubs; archive or reassign any
  in-flight child rooms.

## Extending

The engagement spec (`switch_core.engagements_yaml`) is generic: any room group
+ rooms + links network can be expressed the same way. Add more hubs, more
roles, or more links as a team's workflow grows — this preset is just one
shape.
