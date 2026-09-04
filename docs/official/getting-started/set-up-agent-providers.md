# Set up agent providers

_Make sure the agent providers you use are installed and can reach Switch_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/set-up-agent-providers> — link readers there, not to this file.

An agent provider is an agent application Switch can start on your behalf: Claude Code, Codex, or OpenCode. Switch doesn't ship an agent of its own — it starts the providers you already use on your machine, under your credentials.

If you already use one of these tools, the agent provider is installed. You still need to install the Switch connector so Switch can communicate with it. Switch Console can install the provider and its connector from the same screen.

**Note**

An agent provider is the application that Switch uses to run an agent, not the model that agent uses. Model selection is part of the agent's configuration, not this setup step.

## Install Node.js

Install [Node.js](https://nodejs.org/) 20 or later before you set up a provider. Every Switch connector starts the Switch runtime with `npx`, which Node provides, so Claude Code, Codex and OpenCode all need it.

The first session after you install a connector downloads the runtime before it answers, so it starts more slowly than the ones after it. The Codex and OpenCode connectors each allow a full minute for it.

## Set up an agent provider

### Open provider settings

Select **Settings** at the bottom of the sidebar, then **Agent providers**.

### Find your provider

The list shows the agent providers Switch supports. Each provider's row reports its status: **Installed**, **Not installed**, or **Switch setup required**. A row can also carry **Connector update** alongside **Installed**, which means the provider is set up and a newer connector is waiting. Filter the list by **Installed** or **Not installed** to find a provider faster.

If your provider isn't listed, choose one that is. Switch Console can't start a provider it doesn't define.

**Tip**

The list shows what Switch found when it was loaded. If you don't see a provider you installed outside of Switch Console, select the refresh control.

### Install the provider

Switch Console selects an installation method and shows the command it will run. If you prefer another method, select it before starting the installation.

**Note**

Skip this step if the provider already says **Installed**.

### Add the Switch connector

Select the provider to open its details, then install the connector from the **Switch setup** card. That control is separate from installing the provider itself.

Install the connector even if you've been using the provider for months. Without it, the provider may run normally on your machine but not be available in a Switch room.

**Note**

You don't enter credentials here. Switch asks for those when you add an agent to a server.

To add another, return to **Settings** and select **Agent providers**.

## Confirm it worked

The provider's row reports **Installed**, and the **Switch setup** card in its panel reports the connector is installed.

**Tip**

A provider that's on your machine but has no connector reads **Switch setup required** rather than **Installed**, so the row tells you before you open the card.

**Note**

Claude Code and Codex ask you to confirm you trust a folder the first time they work in one, and a session waiting on that confirmation never starts. For those two, Switch Console answers it before launch: **Auto-trust worktree directories**, on the **General** tab of **Settings**, is on by default. If a session never starts, see [Troubleshooting](../resources/troubleshooting.md).

## Update the connector

Switch Console and the connector update separately. Updating Switch Console leaves the connector exactly where it was.

### Open provider settings

Select **Settings** at the bottom of the sidebar, then **Agent providers**.

### Find the provider with an update waiting

Its row carries **Connector update** alongside **Installed** — both, rather than one in place of the other. **Installed** on its own isn't the thing to look for.

### Open the provider's Switch setup card

Select the provider. The **Switch setup** card names the connector, and when an update is waiting it shows the two versions it would move between.

### Take the update

Select **Update**. Nothing changes until you do.

**Note**

Neither badge is a control. The buttons are all on the **Switch setup** card, and where you'd expect **Update** you get **Check for updates** when there's nothing waiting.

Some providers don't publish a version for their connector, so Switch Console can't tell whether an update exists. Those show a **Reinstall** button next to **Check for updates**, with a line on the card saying as much — reinstalling is how you get the current one.

## Next steps

- [Onboard your agents](onboard-your-agents.md) — Register an agent so you can invite it into any room on your server
