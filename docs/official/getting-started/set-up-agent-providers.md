# Set up agent providers

_Check that the AI coding agent you use is installed and signed in, so Switch can start it_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/set-up-agent-providers> — link readers there, not to this file.

Switch works with these AI coding agents: Claude Code, OpenCode, Codex, Cursor, and Antigravity. We call the one you choose your **agent provider**.

Switch doesn't include its own AI agent. Instead, it starts your chosen provider under your own account, on a machine you control: this computer, or a remote host you've onboarded, such as a virtual machine or another machine you reach over SSH.

**Note**

This is different from an agent you build and run in a hosted platform, such as Salesforce Agentforce or Microsoft Copilot Studio. Those agents run on their platform and aren't agent providers that Switch can start.

What **Auto mode** lets an agent do without asking depends on the provider. See [Let the agent act without asking](agent-settings.md#let-the-agent-act-without-asking).

## Before you begin

Switch starts the provider wherever the agent runs. For an agent on this computer, set the provider up here. For an agent on a remote host, set it up on the host. See [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host).

## Check your agent provider

At the bottom of the sidebar, select **Settings**, then **Agent providers**. The list is headed **All agents** and shows every provider Switch supports. The line under each provider's name says whether it's ready:

| Line under the name | What to do |
| :-- | :-- |
| **Signed in** | The provider is ready. See [Confirm the setup](#confirm-the-setup). |
| **CLI not installed** | [Install the provider](#install-the-provider). |
| **Not signed in** | [Sign in to the provider](#sign-in-to-the-provider). |

Go by the line under the name, not the **Installed** or **Not installed** badge. A row can read **Installed** while the provider still isn't ready.

### Install the provider

Select the provider to open its details. If it isn't installed, Switch Console offers to install it there. If Switch Console can't install it on your computer, install the provider's command-line tool (CLI) the way its own documentation describes. Then, on **Agent providers**, select the refresh icon. Switch Console checks `~/.local/bin` each time you refresh, so it finds a CLI installed there without a restart.

If the line still reads **CLI not installed**, the installer put the CLI somewhere else. Quit Switch Console completely and open it again, so it rereads your PATH:

### macOS

Press Command+Q. Closing the window leaves Switch Console running.

### Windows

Close the Switch Console window, which quits it, then open Switch Console again. If it doesn't open again, see [Switch Console doesn't open right after you close it](../resources/troubleshooting.md#window-doesnt-quit).

### Linux

Close the Switch Console window, which quits it, then open Switch Console again. If it doesn't open again, see [Switch Console doesn't open right after you close it](../resources/troubleshooting.md#window-doesnt-quit).

If it still reads **CLI not installed** after you reopen Switch Console, see [Getting an agent running](../resources/troubleshooting.md#getting-an-agent-running).

### Sign in to the provider

Select the provider to open its details. Under **Run in a terminal on this computer, then Recheck**, the details show the provider's sign-in command, with a **Copy** button. Run the command in a terminal, sign in, then select **Recheck**. For a provider on a remote host, sign in from the host instead. See [Run an agent on the host](../deploy/host-remotely.md#run-an-agent-on-the-host).

Switch uses the account the provider is signed in to, whether that's a subscription or an API key. When you first set up switch-buddy, its setup runs the sign-in for you. From **Agent providers**, Switch Console can't sign you in itself. If the sign-in command doesn't work for you, see the provider's own documentation.

## Confirm the setup

You're ready to add an agent when:

- The line under the provider's name reads **Signed in**.
- The card in its details reads **Signed in** and **CLI installed**.

For example, a Claude Code setup that's ready reads **Signed in** under the name. Its card reads **Claude Code · Signed in**, with **On this computer · CLI installed** beneath.

**Note**

Claude Code and Codex may ask you to confirm that you trust a folder the first time they work in it. A session can't start while it waits for this confirmation.

Switch Console confirms it for you before launch. **Auto-trust worktree directories**, under **General** in **Settings**, is on by default.

If a session still doesn't start, see [Troubleshooting](../resources/troubleshooting.md).

## Update the provider

Switch Console also shows when a newer version of the provider CLI is available. In the provider's details, the **Installation** section reads **Newer version available**, with the command it runs and an **Update** button.

This updates your provider, not Switch.

## Next steps

- [Add a custom agent](add-a-second-agent.md) — Register an agent so you can invite it into any room on your server
