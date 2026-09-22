# Corrections

Append-only. One entry each time the expert is proven wrong, or hits a question it could
not answer from anything in this repository.

**Write the entry the moment it happens**, not at the end of the conversation. Then fix the
knowledge file that was wrong and open a pull request. If you cannot open one, say in the
entry what you would have changed.

Never edit or delete an existing entry. A correction that is itself corrected gets a new
entry that supersedes the old one, so the record of what was believed when survives.

## Format

```
### YYYY-MM-DD — one-line summary

- **Said:** what the expert asserted.
- **Actually:** what is true.
- **Confirmed by:** where the real answer came from — a file and line, a command and its
  output, a release tag, or the person who corrected it.
- **Fixed in:** the knowledge file changed, and the PR — or `not fixed`, and why.
```

For a gap rather than a wrong answer, use the same shape with `**Said:** could not answer`
and describe what was asked.

## Entries

### 2026-08-24 — an agent's working directory cannot be changed after creation

- **Said:** the agent's working directory is "a field you set in Switch Console when you
  create the agent (and you can change it later in the agent's settings)".
- **Actually:** it is fixed at creation. Switch Console's new-agent dialog is the only place
  it can be set; the agent's settings expose instructions, auto-session, auto-approve,
  addressing and advanced provider configuration, and show the directory read-only at most.
  Moving an agent means removing it and adding it again. The editable "Repo dir" on the web
  dashboard's agent page (and via the agent-update tool) is metadata for the generated
  copy-and-paste session command only — editing it does not relocate anything, it just makes
  the dashboard disagree with where the agent actually runs.
- **Confirmed by:** Switch Console's new-agent dialog and settings panel in `console/`, which
  has no directory field or update path after creation; and `repo_dir`'s only consumer being
  the generated connect command in `core/switch_core/gateway/known_agents.py`.
- **Fixed in:** `AGENT.md` (Switch Console steps) and `knowledge/GOTCHAS.md` (new entry).

### 2026-08-24 — "who can talk to your agent" has four choices, and it is in the settings

- **Said:** the setting can be opened up to "all the agents you own", "everyone in the rooms
  the agent is in", or "a specific list" — then declined to say where it is, on the grounds
  that the app gets redesigned.
- **Actually:** four choices — only me (the default), only me and my agents, anyone, and
  custom rules — and "only me and my agents" still includes the owner. It appears in the
  same form both on the create-agent dialog and in the agent's settings, where it saves as
  soon as it is changed. Declining to say where it is was unnecessary: Switch Console's
  source is in this repository and could have been read.
- **Confirmed by:** the addressing-policy control in `console/`, and `AddressingPolicy` in
  `core/switch_core/addressing.py`.
- **Fixed in:** `AGENT.md` — the four choices are written out, and the "never describe a UI"
  rule now says to read the Console source rather than asking the person what they see.
