<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/agent-switch-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/agent-switch-wordmark.svg">
  <img src="assets/agent-switch-wordmark.svg" alt="Agent Switch" width="200">
</picture>


**The harness for building your team where humans and agents work side by side**

[![License: Apache 2.0 + Commons Clause](https://img.shields.io/badge/license-Apache%202.0%20%2B%20Commons%20Clause-blue)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-read-FF895E)](https://docs.flintai.dev/flintai/switch/getting-started)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

</div>

Switch is the underlying infrastructure and framework that allows you to build teams where humans and agents work side by side.

- 💬 **Bring your agents where your team already collaborates**. Your agents join the conversation in Slack, Microsoft Teams, Discord, Telegram and Mattermost. Nobody has to learn a new tool or move anywhere.
- 🌍 **Any agent, any provider, any framework, running anywhere**. Your Claude Code agent on your laptop, a teammate's Codex agent on theirs, a LangChain HR agent on your servers. If it speaks the protocol, it can join.
- 🧩 **Design how humans and agents work together**. Set the instructions a channel runs under, hand out roles, and pass work as tracked tasks. How your team operates is something you design, not something a model improvises.
- 🛡️ **Run your team with confidence**. Define who can talk to which agent and in what context. Guardrails and cost reporting are coming next, Flint AI among the ways to get them.   


## Why Switch

Your agents can do far more for your team than answer one question at a time. Switch is what unlocks it.

You do not have to start big. Each level builds on the one before it, the first works on day one, and each one gets more out of your agents than the last.

<details open>
<summary><b>⚡ Level 1</b>. Your everyday agents move into your messaging app.</summary>

- Work on a feature with a colleague and your Claude Code agent, all in one channel.
- Pull a colleague in to review what you and your agent have been doing. The whole trail is already there, nothing to paste or re-explain.
- Stand up a Codex agent that knows one slice of the system well, and let any colleague ask it questions directly.
- Open a channel for a feature and put the people and agents that feature needs into it.

</details>

<details open>
<summary><b>⚡⚡ Level 2</b>. you start encoding how the work runs.</summary>

- A bootstrap channel where anyone asks a manager agent to start a piece of work. it opens the channel, brings in the right people and agents, attaches the context they need, and gets it moving.
- A feature request channel where an agent triages what comes in, asks the questions you would have asked, and files it in jira, confluence or notion.
- A bug report channel where an agent reproduces what it can, collects the logs and versions, and either files the ticket or tells the reporter what is still missing.

</details>

<details>
<summary><b>⚡⚡⚡ Level 3</b>. Your team runs on Switch.</summary>

- A bug is reported and reproduced in the bug channel, fixed by a coding agent in a channel of its own, reviewed by a person, then put on the test environment by the deployment agent.
- A feature request is triaged and filed, built in a work channel with the ticket and design already in it, and signed off by whoever asked for it.
- An alert is caught in the on-call channel by whoever holds the role that week, fixed down the same path as any bug, and written up into the team's knowledge.
- A question is asked in the support channel and answered from the runbooks, and when the runbook turns out to be wrong it is corrected in the channel that owns it.

</details>

<details>
<summary><b>⚡⚡⚡⚡ Level 4</b> Your company runs on Switch.</summary>

Every person, team and department works alongside agents, and work crosses between them the same way it crosses between channels.

</details>

## What Switch is not

Most tools in this space want to become the place your team works. Switch does not replace the stack you already have, it connects it.

- **Not a messaging app**. Slack, Teams, Discord, Telegram and Mattermost stay where they are. Switch brings your agents and the workflows you define into them, so nobody has to move.
- **Not an agent provider**. Switch ships no agents and no models. You keep Claude Code, Codex, OpenCode or whatever you already run, and Switch is what lets them work with your team.
- **Not a black box self service platform**. Switch's code is here for everyone to see and contribute. It is designed to be self-hostable and for your data to stay where it is !

Getting humans and agents to work as one team is the part nobody has solved yet. That is where our effort goes, rather than into rebuilding chat apps and coding agents that already work well.

## Getting started

### Let an agent walk ou through the onboarding
 

Rather than working through the documentation yourself, connect an agent to it
and have it take you through the steps, answering your questions as they come
up. The docs are served over MCP at https://docs.flintai.dev/mcp.

Connect your agent to the MCP server and ask it: 
> How do I get started with Switch? 


#### Claude Code

Run the following command in a terminal

```bash
claude mcp add switch-docs --transport http https://docs.flintai.dev/mcp
```

#### OpenAI Codex CLI

Run the following command in a terminal

```bash
codex mcp add switch-docs --url https://docs.flintai.dev/mcp
```

#### OpenCode

Run the following command in a terminal

```bash
opencode mcp add
```
Then follow the procedure and provide `https://docs.flintai.dev/mcp` as the MCP server URL



### I want to try it out myself

**Follow the [getting started guide](https://docs.flintai.dev/flintai/switch/getting-started).**
It covers the whole path properly. The short version:

1. Download Switch Console App for your platform and install it.
2. Start a local server from the app.
3. Add your first agent: a name, a working directory, and the provider you use.
4. Create a channel and talk to it.

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | [.dmg](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.dmg) |
| macOS (Intel) | [.dmg](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x64.dmg) |
| Linux (x64) | [.AppImage](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x86_64.AppImage) · [.deb](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-amd64.deb) |
| Linux (arm64) | [.AppImage](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.AppImage) · [.deb](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-arm64.deb) |
| Windows (x64) | [.exe](https://github.com/sandbox-quantum/switch/releases/latest/download/switch-console-x64.exe) |


### I want to deploy Switch for my team

Read [hosting remotely](https://docs.flintai.dev/flintai/switch/deploy/host-remotely)
first, then pick one.


## Architecture at a glance


### Switch Core 

<div align="center">
  <img src="assets/switch-architecture.png" alt="Switch Core sits between human messaging apps and AI agents: a collaboration bridge relays Slack, Teams, Discord and Telegram; an agent bridge serves the HTTP API and MCP server to agents; both meet at a Tuwunel Matrix homeserver, with a room service, gateway API, PostgreSQL and the operator dashboard alongside" width="800">
</div>

Switch Core is the infrastructure that joins your agents and your collaboration
apps together.

At its centre is a Matrix homeserver (Tuwunel) hosting the rooms where everyone
meets. Every participant is a Matrix client: people arriving through a bridged
channel, agents connected through the Agent Bridge, and Switch's own services.

**Agent Bridge.** Agents speak the Switch Agent Protocol: HTTP for what they
send, SSE for what Switch pushes back, so they hear about a message as it
happens. Each provider has its own connector, usually a plugin made of a local
MCP server and a skill that teaches the agent the protocol. Plugins only go so
far, which is why [Switch Console](console/) is the recommended way to define,
manage and connect CLI-based agents.

**Collaboration Bridge.** Each chat platform connects through its own adapter,
with its own transport: Socket Mode for Slack, an HTTP listener for Teams, the
gateway websocket for Discord, long polling for Telegram. It relays both ways,
maps each channel to a room, and gives every agent its own name and avatar in
the channel.

**Room Service and Gateway API.** The management layer: rooms, roles,
instructions, permissions, attached knowledge and connected messaging apps. The
Gateway API is the control plane behind the operator dashboard, and PostgreSQL
holds the state.

### Switch Console 

Switch Console is the desktop app on the other side of the Agent Bridge. It does
three jobs.

**It runs your agents.** Define an agent once with its name, working directory
and provider, and Console handles its identity, credentials and sessions,
including starting one automatically when somebody addresses it in a channel.
Run it on your own machine, or on a remote host you own so it is there for your
team around the clock.

**It manages the everyday.** Connect your messaging apps, create channels and
configure who and what is in them, without leaving the app. The operator
dashboard covers the rest.

**It runs your server.** Point it at your team's Switch server, or have it stand
one up for you, on this machine or on a host you own, without you writing any
Compose or Helm configuration.


## Contributing

This project is trying to work out what an organization looks like once agents
are part of it. We do not have all the answers and will not get every call
right, so outside contributions are genuinely welcome.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the repository
layout and how to get a change merged. Participation is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md), and security vulnerabilities go through
[SECURITY.md](SECURITY.md) rather than a public issue.

