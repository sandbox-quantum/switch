---
name: switch-buddy
description: Router for switch-buddy's version-matched reference guides in .switch/skills/. Read this first when onboarding a user, creating an agent or room, setting up connectors or messaging apps, choosing a machine/folder/approvals, or linking Switch Console.
---

# switch-buddy guides

Read only the guide you need for the current task (all live in `.switch/skills/`,
delivered by this Switch server and matched to its version). **Always read the whole
guide file in full** — do not truncate with `head`, `sed` or `grep`:

| When you need to… | Read |
|---|---|
| Run onboarding, handle the Welcome opener, ask the work question, or offer choices / question forms | `.switch/skills/switch-buddy-onboarding/SKILL.md` |
| Propose and create their first agent, create a private room, introduce it, set a schedule, or create a new room from templates | `.switch/skills/switch-buddy-first-agent/SKILL.md` |
| Set up or troubleshoot Telegram/Teams private channels, add people to a room, put an agent in a channel, link a chat account, or add a messaging app | `.switch/skills/switch-buddy-channels/SKILL.md` |
| Recommend or connect services (GitHub, Jira, Google…), check machine logins, or explain Console-run connectors | `.switch/skills/switch-buddy-connectors/SKILL.md` |
| Pick a machine (computer vs Switch Cloud), find a folder, configure approvals (`auto_mode` / bypass), or explain server types / server settings | `.switch/skills/switch-buddy-hosting/SKILL.md` |
| Link Switch Console pages, answer common setup FAQs, check Switch docs/releases, or handle a new version of switch-buddy | `.switch/skills/switch-buddy-console/SKILL.md` |

## What you can do yourself

With Switch's tools and "can manage agents", you can, once they say yes:
- **Agents:** `list_machines`, `create_agent`, `list_managed_agents` (check it came up before saying it's ready), `update_agent_detail`.
- **Rooms:** `list_bridges`, `create_room` (put your own name in `agent_names` — `create_room` does not add you, and you can only change a room you are in later; `caller_is_member` confirms; direct rooms take one agent only), `invite_agent_to_room`, `remove_agent_from_room`, `add_users_to_room`, `create_room_schedule`, plus roles, links, groups and aliases.
- **Templates & material:** `list_templates`, `get_template`, `run_template`, `save_template`, references and room documents.
- **Services:** `set_agent_service` / `remove_agent_service` on your owner's own agents, only after a yes.
