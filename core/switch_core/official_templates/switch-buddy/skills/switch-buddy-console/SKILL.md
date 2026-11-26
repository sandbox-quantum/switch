---
name: switch-buddy-console
description: Switch Console deeplinks, Console-only actions, common setup FAQs, Switch docs lookup, and handling a new revision of switch-buddy.
---

# Switch Console links, docs & FAQs

## Switch Console links

Use a Markdown link in words they would say (e.g.
`[Connect a messaging app](switchdash://open/messaging-apps/connect)`). One link per place,
when needed; never a list of every page. Never assume someone on Slack or another
messaging app has Switch Console access: say plainly when a link opens in Switch Console.

| Page | Link |
|---|---|
| Link their chat accounts (Messaging apps in Switch Console's settings) | `switchdash://open/settings?tab=messaging-apps` |
| Every agent | `switchdash://open/agents` |
| Add a new agent | `switchdash://open/agents/new` |
| An agent's page (`tab=chats`, `tab=connections` for its services, or `tab=settings`) | `switchdash://open/agent/<agent-id>?tab=settings` |
| A direct chat with an agent | `switchdash://open/chat/<room-id>` |
| Your own page (`tab=settings` for your settings) | `switchdash://open/buddy?tab=settings` |
| Connect a messaging app | `switchdash://open/messaging-apps/connect` |
| Connectors: services such as GitHub | `switchdash://open/connections` |
| The server's home: the workspace at a glance (not where accounts or guardrails are) | `switchdash://open/home` |
| This server's own settings, when their Switch Console runs it: start, stop, restart, update | `switchdash://open/server` |
| Every room | `switchdash://open/rooms` |
| A room | `switchdash://open/room/<room-id>` |
| Templates (`tab=agent`, `room` or `group`) | `switchdash://open/templates` |
| A template | `switchdash://open/template/<template-id>` |
| Invite people to the workspace | `switchdash://open/invite` |
| Admin, for workspace admins: the workspace's messaging apps (`tab=messaging-apps`) and which connectors it offers (`tab=connectors`); for whoever runs the server, Switch Trust guardrails (`tab=switch-trust`) and, on a Switch run without Docker, the apps connectors sign in through (`tab=apps`). A server's status is in settings (`tab=status`) | `switchdash://open/admin` |
| Switch Console's settings (`tab=preferences`, `messaging-apps` to link their accounts, `clis-models` for agent providers, `api-keys`, `devices`, `remote-hosts` for SSH hosts, `managed-agents`, `status` or `account`) | `switchdash://open/settings` |

- An agent's id comes from `list_managed_agents`, a room's from `list_rooms` or the tool
  that made it, a template's from `list_templates` (only templates saved on the server
  have a page). An agent's page exists only for the person's own agents.
- **Console-only actions (say so early and link the page):** connecting a messaging app
  (`switchdash://open/messaging-apps/connect`), inviting people (`switchdash://open/invite`,
  not on a Console-run server), changing guardrails
  (`switchdash://open/admin?tab=switch-trust`), server lifecycle
  (`switchdash://open/server`), connecting services when there's no web dashboard URL
  (`switchdash://open/connections`), and deleting an agent
  (`switchdash://open/agent/<agent-id>?tab=settings`).

## Published Switch docs

- **What Switch is, screens, settings, setup patterns:** read fresh with your web fetch
  tool (`WebFetch` / `webfetch` / `curl -sL`): start with the index
  `https://docs.switchagents.ai/llms.txt`, then fetch only the page needed (search
  `https://docs.switchagents.ai/llms-full.txt` only if the index doesn't point at it).
  Don't fetch for greetings or questions you already know. If their `server.version`
  (`get_my_context`) is older and a feature seems missing, say the docs may be newer than
  their Switch.
- **Rooms, messages and roles:** the Switch skill already in your context.
- **Versions and downloads:** fetch
  `https://api.github.com/repos/sandbox-quantum/switch/releases?per_page=3`; never from
  memory.

## Common setup requests

- **General setup pattern:** (1) understand the goal (who, problem, done — 1–2 questions
  at a time); (2) start from what exists (`list_templates` or docs); (3) propose, wait for
  a yes, then build it and report in 1–2 lines; (4) iterate.
- **"I want my team to talk to you" / to another agent:** A new agent answers its owner
  and the owner's own agents; other people and their agents cannot. The setting is "Who
  can talk to your agent" (`switchdash://open/agent/<agent-id>?tab=settings`); "Anyone"
  admits anyone in the rooms the agent is in. You can change it for another agent with
  `update_agent_detail` once they say so. Warn them: a person whose chat account is not
  linked to Switch is not recognised, and the agent won't answer them until they link it.
- **"Put you (or an agent) in a channel":** read
  `.switch/skills/switch-buddy-channels/SKILL.md` § "Putting an agent in a channel".
- **"How does one agent ask another to do something?":** a targeted message in a room they
  are both in. That is the whole answer.

## When a new version of you arrives

When the server starts on a newer switch-buddy template, it brings you up to it by itself:
anything nobody had changed (instructions, skills, description, icon) follows, with
nothing for you to do or say.

What it never touches is what your owner changed, and your permissions (whether you can
manage agents, who can talk to you). When it left any of those as they were, a `[Switch]`
line before a message says your template has a new revision. Then:

1. **Call `get_template_status`.** It lists each value of yours that differs from the new
   version, with the recommended one, and each permission the new version sets differently.
2. **Tell your owner, briefly, when you next answer them.** For each difference: what they
   would gain by taking the new version, and what they would lose (their own change). A
   formatting change can be a single line. Lead with permissions if there are any, and say
   plainly that Switch did not change them.
3. **Let them decide.** You cannot change your own settings; they do it on your page (link
   its settings tab). Attach long recommended text as a file rather than pasting it.

Don't bring it up again once they have decided, and don't hold up what they asked for:
answer that first, then mention the update in a line or two.
