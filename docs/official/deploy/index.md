# Choose how to run Switch

_Compare the ways to run a Switch server, and pick the one that fits your team_

Published at <https://docs.flintai.dev/flintai/switch/deploy> — link readers there, not to this file.

A Switch server hosts your rooms and the agents registered against it. Your agents themselves run wherever you point them — your own computer, or a machine you own — so what you are choosing here is where the server runs and who can reach it.

**You may have met this question already.** Switch Console asks a version of it in its **Add a server** step, where you are choosing how your own copy reaches a server so you can get an agent running. This page is the same decision one level up: what the team runs, and who can reach it. Answer it here if the server is yours to stand up, and in [Add a server](../getting-started/add-a-server.md) if you only need one to work against.

Every option runs the same software. The container images, the Helm chart, and the Compose file are published together under one version, so the difference between them is not what you get, but who sets it up and who it is reachable by.

## Compare the options

| Option | Choose it when | What it asks of you |
| :-- | :-- | :-- |
| **Switch Console, on this computer** | You're trying Switch out, or your agents only need to answer while your own computer is on. | Docker on your machine. |
| **Switch Console, on a host you own** | Your team works with your agents in a messaging app, and needs them answering around the clock. | An SSH host with Docker, onboarded in Switch Console. |
| **Docker Compose, run by you** | Your team needs a server of their own — their own agents on it, and the Gateway to administer it. | A Linux machine you administer, a name it answers on, and a certificate. |
| **Kubernetes, using the Switch chart** | You already run a cluster, and you want ingress, an external database, or single sign-on. | A cluster, an ingress controller, and someone who operates them. |

Everything follows from one split: **Switch Console can run the server for you, or you can deploy it yourself.**

## Let Switch Console run the server

Switch Console starts the stack with Docker, chooses free ports, creates the administrator account, and signs you in. There is no configuration to write, no certificate to obtain, and no address to copy.

**Your colleagues can still work with your agents.** Connect the server to Slack, Discord, or Telegram and Switch reaches out to the platform rather than waiting to be called, so anyone in that workspace can address your agents in a channel without reaching your server at all. Microsoft Teams is the exception — it delivers to Switch, so it needs a server the internet can reach.

What a server Switch Console runs doesn't give anyone is a server of their own. Nobody else signs in to its Gateway and nobody else registers their own agents against it: a local server publishes to that computer only, and a server on a host you've onboarded is reached through an SSH forward belonging to your copy of Switch Console. **Your agents are shareable; the server is yours.**

That's what separates the first option from the second. A server on your own computer answers while your computer does, so your agents go quiet when you close the laptop. Put it on a host you own and the agents keep answering your team overnight and at the weekend, which is usually the reason to move.

Switch Console pins the server version it installs, and that pin can sit behind the newest published server release — deliberately, so the app never installs images before they exist. A managed server reporting an older version than the latest release is working as intended.

Set either of these up from [Add a server](../getting-started/add-a-server.md). A host has to be onboarded first — see [Onboard a remote host](host-remotely.md).

## Run the server yourself

Deploy the server yourself when other people need to reach the server itself: colleagues signing in to the Gateway, teammates registering their own agents against it, or Microsoft Teams, which has to reach Switch over the internet.

Sharing your agents is not on that list, and it's the common reason people reach for this too early. If all your team needs is to work with agents you run, a server Switch Console runs on a host you own already does that.

You obtain and renew the certificate, and you decide what the server is reachable on. In exchange you get a server that outlives any one laptop and that your team connects to for themselves.

Switch Console connects to a server you deployed exactly as it connects to any other running server — through **Connect to an existing server**, with the Gateway and API addresses. Deploying it yourself does not take you outside the app.

See [Host Switch for your team](self-host.md).

## What runs, whichever you choose

A Switch server is several services rather than one:

- **switch-core** — the agent API and the MCP server your agents connect to.
- **Tuwunel** — the Matrix homeserver that carries room messages.
- **PostgreSQL** — rooms, agents, and the rest of the server's state.
- **The Gateway** — the operator dashboard, where you administer rooms and connections in a browser.
- **Mattermost** — optional, and brought up for you by Switch Console so a managed server has somewhere to talk from the moment it starts. Deploy the server yourself and you choose whether to include it or connect the messaging app your team already uses.

Whatever hosts them, agents reach switch-core and people reach the Gateway. Connecting a messaging app is a separate step on every option — see [Connect Switch to a messaging app](messaging-apps/index.md).

## Next steps

- [Add a server](../getting-started/add-a-server.md) — Have Switch Console run the server, on this computer or on a host

- [Host Switch for your team](self-host.md) — Deploy the server yourself, with Docker Compose or on Kubernetes
