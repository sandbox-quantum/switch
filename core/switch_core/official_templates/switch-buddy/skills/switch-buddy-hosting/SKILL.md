---
name: switch-buddy-hosting
description: Choosing where an agent runs (computer vs Switch Cloud), finding its working folder, configuring approvals (auto mode and bypass across providers), server types, and server settings.
---

# Machines, folders, approvals & servers

## Where it runs (which machine)

Don't pick the machine silently. On Switch Cloud they usually have their computer and
their cloud machine (`kind` "ec2" in `list_machines`): "Should it run on your computer, or
on Switch Cloud so it keeps working when your computer is off?" Computer-hosted agents
answer only while Console is open; recurring or team agents belong on Switch Cloud.

- **The cloud machine shows `offline`:** it sleeps when unused. You can still create the
  agent there: that wakes it, and the agent starts once it is up, in a few minutes. Say so
  in the proposal, and give it up to ten minutes before saying it did not come up. If
  creating it is refused as offline, they stopped the machine themselves: ask them to
  press **Start** on its card under [your agents](switchdash://open/agents), then try
  again.
- **No cloud machine is listed:** a workspace that never used one has none yet. Ask them
  to open [Add a new agent](switchdash://open/agents/new) and choose **Switch Cloud**
  under where it runs, which sets it up. Then ask again, and create the agent once
  `list_machines` shows it.
- **Only their computer is listed and they're on Switch Cloud:** say the cloud machine is
  an option before proposing their computer.
- On a server Switch Console runs, or one with no cloud machines, their computers are the
  only choice: don't mention the cloud.

## Where it works (its folder)

For an agent on this computer, ask in plain words whether it should use an existing folder
or a fresh folder of its own; for another machine, ask for a path if they want one. Don't
look first.

- **Named folder:** expand `~`, check it exists before proposing.
- **Vague ("my API repo", "the docs folder", "somewhere with my notes"):** then, and only
  then, look. Keep it shallow: the usual places (`~/code`, `~/src`, `~/Projects`,
  `~/Developer`, `~/Documents`, the desktop) and a level or two down, matching what they
  said. List folder names and look for signs only (a version-control folder, `CLAUDE.md`,
  `AGENTS.md`, `.claude/`, `.codex/`, `.cursor/`); don't open their files. Offer at most
  three, each with one line on why ("a repository, already has a CLAUDE.md"), and let them
  pick.
- **No folder:** omit `directory` for a fresh one.
- **Existing folder — say once:** it can read and edit files there (without asking if
  bypass is on), inherits that folder's provider setup (instructions, skills, MCP), and
  shares edits with other agents in that folder.

## Asking before acting (auto mode and bypass)

- **Cursor:** Cursor's ACP interface has no automatic review, so new Cursor agents default
  to `auto_mode: false`, `auto_approve: true`. Disclose in the proposal that it runs
  without asking (set both false if they ask for approvals). Never turn bypass on for an
  existing agent without an explicit request.
- **OpenCode:** OpenCode's auto mode runs every command unreviewed, so new OpenCode agents
  start with auto mode off and ask before each action (turn it on only if they ask, after
  disclosing commands will run unreviewed).
- **Other providers:** default to `auto_mode` on (safe actions run, risky ones ask).
  Bypass (`auto_approve`) runs everything without asking and overrides auto mode — unsafe,
  so leave bypass off and omit `auto_mode` (provider default) unless they explicitly say
  yes in the proposal ("It will ask you before anything risky. Should it instead go ahead
  on everything without asking?").
- **For yourself:** you can't change your own settings. The first time a task needs
  several approvals, note once that they can enable Bypass permissions in
  [my settings](switchdash://open/buddy?tab=settings).
- **Other agents:** change via `update_agent_detail` only after a yes to that exact change
  (`auto_mode`/`auto_approve` in `list_managed_agents` or `get_my_context`).

## Which server they're on

- **Switch Cloud:** messaging apps usually have the official app, and their agents can run
  on a cloud machine or their computer.
- **A server Switch Console runs:** it comes with a built-in messaging app. Their agents
  run on their computer, and Console must be open for them to answer. Usually it runs on
  their own computer, which nobody else can reach, so don't suggest inviting people (Switch
  Console does not offer it there). If they ask, say so; to work with others they need a
  server those people can reach (Switch Cloud, or one their team hosts).
- **Self-hosted:** whoever runs the server decides what's available. When something isn't
  offered (`available` false, with `unavailable_reason`), say so plainly; it's that
  operator's to turn on.

## Server settings

Starting, stopping, restarting or updating the server: `switchdash://open/server`. Only
for a server their Switch Console runs (`get_my_context` says which); anyone else's is run
by whoever set it up, so send them there.
