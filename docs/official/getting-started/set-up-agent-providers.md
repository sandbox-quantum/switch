# Set up agent providers

_Check that the AI coding agent you use is installed and signed in, so Switch can start it_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/set-up-agent-providers> — link readers there, not to this file.

Switch works with these AI coding agents: Claude Code, OpenCode, Codex, Cursor, and Antigravity. We call the one you choose your **agent provider**.

Switch doesn’t include its own AI agent. Instead, it starts your chosen provider under your own account, on a machine you control: this computer, a virtual machine, or a server you’ve onboarded.

**Note**

This is different from an agent you build and run in a hosted platform, such as Salesforce Agentforce or Microsoft Copilot Studio. These agents remain managed by their platform and aren’t agent providers that Switch can start.

## Before you begin

Your provider must already work on this computer. Sign in with your subscription, or set up your API key, and check that you can use the provider on its own.

**Warning**

Switch Console can’t sign you in to your provider. If the provider asks you to sign in, do it in the provider itself.

## Check your agent provider

### Open agent provider settings

Select **Settings** at the bottom of the sidebar, then **Agent providers**.

The list is headed **All agents** and shows every provider Switch supports.

### Read your provider's status

The line under the provider's name tells you whether it's ready:

- **Signed in:** The provider is ready. Skip to [Confirm the setup](#confirm-the-setup).
- **CLI not installed:** Install the provider.
- **Not signed in:** Sign in to the provider.

Each row also has a badge, **Installed** or **Not installed**. Go by the line under the name instead: a row can read **Installed** while the provider still isn't ready.

If you've just installed or signed in to a provider and its row hasn't changed, select the refresh icon to check again.

### Install the provider

**Note**

Skip this step unless the line under the provider's name reads **CLI not installed**.

Install the provider's command-line tool (CLI) the way its own documentation describes. Then come back to **Agent providers** and select the refresh icon.

### Sign in to the provider

**Note**

Skip this step if the line under the provider's name reads **Signed in**.

Open the provider outside Switch and sign in. Switch uses the account the provider is signed in to, whether that's a subscription or an API key.

Each provider has its own sign-in process. See the provider's documentation for details.

### Check the status again

Select the provider to open its details. The card at the top shows whether you're signed in and whether the CLI is installed.

Select **Recheck** to update it.

## Confirm the setup

You're ready to onboard an agent when:

- The line under the provider's name reads **Signed in**.
- The card in its details reads **Signed in** and **CLI installed**.

For example, a Claude Code setup that's ready reads **Signed in** under the name. Its card reads **Claude Code · Signed in**, with **On this computer · CLI installed** beneath.

**Note**

Claude Code and Codex may ask you to confirm that you trust a folder the first time they work in it. A session can’t start while it waits for this confirmation.

Switch Console handles this before launch. **Auto-trust worktree directories** is turned on by default under **Settings > General**.

If a session still doesn’t start, see [Troubleshooting](../resources/troubleshooting.md).

## Update the provider

Switch Console also shows when a newer version of your provider's CLI is available. In the provider's details, the **Installation** section reads **Newer version available**, with the command it will run and an **Update** button.

This updates your provider, not Switch.

## Next steps

- [Onboard agents](onboard-your-agents.md) — Register an agent so you can invite it into any room on your server
