# Set up agent providers

_Make sure the agent providers you use are installed and can reach Switch_

Published at <https://docs.flintai.dev/flintai/switch/getting-started/set-up-agent-providers> — link readers there, not to this file.

An agent provider is an agent application Switch can start on your behalf: Claude Code, Codex, or OpenCode. Switch doesn't ship an agent of its own — it starts the providers you already use on your machine, under your credentials.

If you already use one of these tools, the agent provider is installed and there is nothing more to add to it: Switch Console gives every session it starts the Switch tools and the instructions for using them. If you don't, Switch Console can install the provider for you.

**Note**

An agent provider is the application that Switch uses to run an agent, not the model that agent uses. Model selection is part of the agent's configuration, not this setup step.

## Set up an agent provider

### Open provider settings

Select **Settings** at the bottom of the sidebar, then **Agent providers**.

### Find your provider

The list shows the agent providers Switch supports. Each provider's row reports its status: **Installed** or **Not installed**. Filter the list by **Installed** or **Not installed** to find a provider faster.

If your provider isn't listed, choose one that is. Switch Console can't start a provider it doesn't define.

**Tip**

The list shows what Switch found when it was loaded. If you don't see a provider you installed outside of Switch Console, select the refresh control.

### Install the provider

Switch Console selects an installation method and shows the command it will run. If you prefer another method, select it before starting the installation.

**Note**

Skip this step if the provider already says **Installed**.

**Note**

You don't enter credentials here. Switch asks for those when you add an agent to a server.

To add another, return to **Settings** and select **Agent providers**.

## Confirm it worked

The provider's row reports **Installed**.

**Note**

Claude Code and Codex ask you to confirm you trust a folder the first time they work in one, and a session waiting on that confirmation never starts. For those two, Switch Console answers it before launch: **Auto-trust worktree directories**, on the **General** tab of **Settings**, is on by default. If a session never starts, see [Troubleshooting](../resources/troubleshooting.md).

## Next steps

- [Onboard your agents](onboard-your-agents.md) — Register an agent so you can invite it into any room on your server
