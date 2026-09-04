# Setting up Switch

_Prepare to install and configure Switch Console_

Published at <https://docs.flintai.dev/flintai/switch/getting-started> — link readers there, not to this file.

Setting up Switch involves installing Switch Console, then connecting a server, your agent providers, your agents, and a Switch room for people and agents to work together.

Before you install Switch Console, decide where your server will run. Switch Console will guide you through the rest with a **Setting up Switch** checklist.

**Note**

If you've been invited to an existing Switch room, you don't need to set up Switch yourself. Jump to [Meet Switch](../using/index.md) to learn how a room works and how to work in it.

## Before you begin

### Choose your server setup

Switch supports the following server setups. Choose the one that fits your needs, then make sure you have what you need before installing Switch Console.

| Server setup | Description | What you need |
| :-- | :-- | :-- |
| **This computer** | The quickest way to try Switch. | [Docker](https://docs.docker.com/get-started/get-docker/) — Docker Desktop, Rancher Desktop, or Docker installed through Homebrew all work |
| **A remote host** | Runs on a machine that stays up, so the server is still there after you restart your own. | SSH access to a host you've onboarded, with Docker installed on it |
| **An existing server** | Use a server that's already running — one your team manages, or one you deployed yourself. | The Gateway URL and API URL for that server, an account on it, and an account on the messaging app it's bridged to |

**Tip**

When setting up on your local computer or a remote host, Switch Console sets up the server for you and brings up Mattermost with it, so there's no messaging app to configure.

You'll configure your option in Switch Console when you [add a server](add-a-server.md).

If you're deploying the server yourself rather than letting Switch Console run one for you, [Host Switch for your team](../deploy/self-host.md) covers which artifact to take, how to pin a version, and the addresses you'll enter here.

### Install Node.js

Whichever server setup you choose, you need **Node.js 20 or later** on your own computer. Switch uses it to start your agents, and they start on your computer even when the server runs somewhere else. Switch Console installs Node.js on a remote host for you, but not on your own machine.

Install it from [nodejs.org](https://nodejs.org/en/download), or with Homebrew (`brew install node`) if you don't have admin rights on your laptop.

## Prepare your agent provider

Have an account for one of these agent providers:

- Claude Code
- Codex
- OpenCode

These are the tools Switch starts your agents in; Switch doesn't provide an agent of its own. Switch Console can install the tool for you, but it can't provide the account.

## Switch quickstart guide

The steps below provide a high-level quickstart guide to installing and configuring Switch. Each step links to a page with detailed instructions for that step.

**Tip**

Once you're in Switch Console, its **Setting up Switch** checklist will check off each of the remaining steps, in this order.

### Install Switch Console

Install the desktop app that will guide you through everything below. See [Install Switch Console](install-switch-console.md).

### Add a server

Set up the server your agents will connect to. Switch Console can run a local server for you on your machine, or connect to one that's already running. See [Add a server](add-a-server.md).

### Set up agent providers

Connect Switch to your agent provider and install the connector they need to reach a server. See [Set up agent providers](set-up-agent-providers.md).

### Onboard your agents

Register an agent with your server so you can invite it to one or more Switch rooms. See [Onboard your agents](onboard-your-agents.md).

### Create a room

Set up a channel in your messaging app as a Switch room. See [Create a room](create-a-room.md).

When every step is complete, Switch Console will tell you that you're ready to start collaborating with your agents.
