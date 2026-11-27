---
name: switch-buddy-connectors
description: Connecting services (GitHub, Atlassian/Jira, Google, Linear, etc.), granting services to agents, onboarding connector recommendations, machine logins, and Console-run server connectors.
---

# Services & connectors

## Services its job needs

Before proposing an agent, work out which services its job needs: Jira or Confluence
(Atlassian), GitHub, Google (Gmail, Drive, Calendar) and the like. `get_my_context` lists
the services your owner connected and whether each is "active" or "not_connected", plus
each service's direct web URL (`services[].url`).

- **Connected:** say in the proposal which ones you will give it and with what access
  (read or write), for example "and I'll give it read access to your GitHub". After they
  say yes and the agent is created, grant them with `set_agent_service`. Only your owner's
  own agents, and only after a yes to that: it hands over their access.
- **Not connected:** say so in the proposal and link where to connect it, then grant it
  once it's "active". Don't create the agent expecting it to find its own way in, and don't
  let it guess.
  - Keep **Settings → Connectors** (`switchdash://open/admin?tab=connectors`, where
    workspace admins switch connectors on/off) distinct from the main **Connectors** page
    (`server.connectors_url` or `[Connectors](switchdash://open/connections)`, where **Set
    up** and account sign-in live). Never tell someone to look for "Set up" on the Settings
    toggle page.
  - Use `services[].url` from `get_my_context` (or `server.connectors_url` /
    `[Connectors](switchdash://open/connections)` if there's no web URL). **Exception:**
    Atlassian (and any connector whose web page says "Connect from Switch Console") can
    currently only be signed into inside Switch Console — say so up front and link
    `[Connectors](switchdash://open/connections)` instead of bouncing them through the
    gateway web UI first.
- **Needs their choice** (such as which GitHub repositories): link the agent's
  Connections, `switchdash://open/agent/<agent-id>?tab=connections`, once it exists.
- **Not offered as a connector:** the machine's own access may cover it; see "Access the
  machine already has" below.

## Onboarding connectors

The connectors to offer after the work question, best first. Offer only those
`get_my_context` lists for the workspace, and leave out any already connected.

| Their answer | Connectors |
|---|---|
| Engineering | GitHub, Linear, Google Workspace |
| Product | Linear, Notion, Google Workspace |
| Design | Canva, Notion, Google Workspace |
| Sales | Salesforce, Google Workspace |
| Marketing | Google Workspace, Canva, Notion |
| Other, or skipped | Google Workspace, GitHub |

Never suggest a service Switch has no connector for (Figma, HubSpot): say the machine's
own access may cover it ("Access the machine already has" below).

## Access the machine already has

An agent also gets what is set up on its machine, with no Switch connector:
- **The AI provider's own tools.** If Claude Code on their computer is connected to Gmail
  (a claude.ai connector, or an MCP server added with `claude mcp add`), the agents that
  run through Claude Code on that computer can use Gmail too. The same goes for MCP
  servers in Codex's `config.toml`.
- **The computer's own logins.** If the computer can already reach GitHub (the `gh` CLI
  signed in, git credentials, SSH keys), an agent running on it can too.

Say so when a service isn't offered or can't be connected as a Switch connector (setting it
up there is the other way), or when someone asks why an agent can reach something nobody
granted it in Switch. Be clear about what that means:
- **Every agent on that machine gets it** (for a provider's tools, every agent on that
  provider). It is not granted per agent, and Switch cannot limit or revoke it; they
  change it on the computer or in the provider.
- **It is their own account.** The agent acts as them there.
- **Only on that machine.** An agent on a cloud machine or another computer does not get
  it.
- It does not show on the agent's Connectors tab.

## Connectors on a server Switch Console runs

The server's address is plain `http://127.0.0.1`. Atlassian, Google and GitHub sign-ins
work there with an up-to-date Switch Console and server, once the server's admin has set
up the vendor app:
- **When the server has a web gateway** (`server.dashboard_url` is set): open the main
  **Connectors** page (`server.connectors_url` or `[Connectors](switchdash://open/connections)`)
  and click **Set up** on the connector's card (or use Organization settings on the
  gateway). Do **not** link "Connector apps" (`switchdash://open/admin?tab=apps`) on a
  server with a gateway — that Settings tab only exists on gatewayless servers.
- **When there is no web gateway** (`server.dashboard_url` is absent): click **Set up** on
  its card in [Connector apps](switchdash://open/admin?tab=apps).

GitHub takes `http://127.0.0.1` because it is the computer's own; it refuses any other
plain http one. For GitHub, the computer's own access ("Access the machine already has")
needs no app at all.
