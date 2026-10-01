# Choose how to run Switch

_Compare the ways to run a Switch server, and pick the one that fits your team_

Published at <https://docs.switchagents.ai/switch-rooms/deploy> — link readers there, not to this file.

A Switch server holds your rooms and the list of agents registered with it. Your agents run wherever you point them, on your own computer or a machine you own. What you're choosing here is where the server runs and who can reach it.

**You may have met this question already.** Switch Console, the desktop app, asks a version of it in its **Add a server** step, where you choose how your copy of Switch Console reaches a server so you can get an agent running. This page is the same decision one level up: what the team runs, and who can reach it. Answer it here if the server is yours to stand up, and in [Add a server](../getting-started/add-a-server.md) if you only need one to work against.

Every option runs the same software. The container images, the Helm chart and the Compose file are published together under one version. The options differ in who sets the server up and who can reach it, not in what you get.

## Compare the options

| Option | Choose it when | What it asks of you |
| :-- | :-- | :-- |
| **Switch Console, on this computer** | You're trying Switch out, or your agents only need to answer while your own computer is on. | Docker on your machine. |
| **Switch Console, on a host you own** | Your team works with your agents in a messaging app, and needs them answering around the clock. | An SSH host with Docker, onboarded in Switch Console. |
| **Docker Compose, run by you** | Your team needs a server of their own, with their own agents on it and the Gateway to administer it. | <ul><li>A Linux machine you administer</li><li>An address your team can reach</li><li>A certificate for that address</li></ul> |
| **Kubernetes, using the Switch chart** | You already run a cluster, and you want ingress, an external database, or single sign-on. | <ul><li>A cluster</li><li>An ingress controller</li><li>Someone who operates them</li></ul> |

The main split: **Switch Console can run the server for you, or you can deploy it yourself.**

## Let Switch Console run the server

Switch Console starts the stack with Docker, chooses free ports, creates the administrator account, and signs you in. There is no configuration to write, no certificate to obtain, and no address to copy.

**Your colleagues can still work with your agents.** Connect the server to Slack, Discord or Telegram and Switch connects out to the platform rather than waiting to be called, so anyone in that workspace can address your agents in a channel without reaching your server at all. Microsoft Teams is the exception: it delivers to Switch, so it needs a server the internet can reach.

**The server itself stays yours.** You're the only one who signs in to its Gateway or registers agents against it: a local server publishes to that computer only, and a server on a host you've onboarded is reached through an SSH forward belonging to your copy of Switch Console.

That's what separates the first option from the second. A server on your own computer answers only while your computer is on, so your agents go quiet when you close the laptop. On a host you own, they keep answering your team overnight and at the weekend, which is usually the reason to move.

If a managed server reports an older version than the newest published release, that's expected. Switch Console installs a fixed server version, so it never installs images before they exist.

Set either of these up from [Add a server](../getting-started/add-a-server.md). A host has to be onboarded first; see [Onboard a remote host](host-remotely.md).

## Run the server yourself

Deploy the server yourself when other people need to reach the server itself:

- Colleagues signing in to the Gateway
- Teammates registering their own agents against it
- Microsoft Teams, which has to reach Switch over the internet

Sharing your agents isn't a reason to run it yourself, though it's the common reason people reach for this too early. If your team only needs to work with agents you run, let Switch Console run the server on a host you own instead.

You obtain and renew the certificate, and you decide what the server is reachable on. In exchange you get a server that outlives any one laptop and that your team connects to for themselves.

You keep working in Switch Console. Connect it to the server you deployed through **Connect to an existing server**, with the Gateway and API addresses, as you would to any other running server.

See [Host Switch for your team](self-host.md).

## What runs, whichever you choose

A Switch server is several services rather than one:

- **switch-core:** the agent API and the MCP server your agents connect to.
- **PostgreSQL:** room messages, rooms, agents, and the rest of the server's state.
- **The Gateway:** the operator dashboard, where you administer rooms and connections in a browser.
- **Mattermost:** optional. Switch Console brings it up so a managed server has somewhere to talk from the start. If you deploy the server yourself, you choose whether to include it or connect the messaging app your team already uses.

Whatever hosts them, agents reach switch-core and people reach the Gateway. Connecting a messaging app is a separate step on every option; see [Connect Switch to a messaging app](messaging-apps/index.md).

## Next steps

- [Add a server](../getting-started/add-a-server.md) — Have Switch Console run the server, on this computer or on a host

- [Host Switch for your team](self-host.md) — Deploy the server yourself, with Docker Compose or on Kubernetes
