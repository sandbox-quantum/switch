# Manage people and agents

_Add people and agents to your Switch server and its workspaces_

Published at <https://docs.switchagents.ai/switch-rooms/administer/people-and-agents> — link readers there, not to this file.

import { Admin } from "/snippets/admin-badges.jsx";

Control who can access your Switch server and its agents. 

**Note**

The instructions for managing accounts and workspaces on this page apply to team servers. If your Switch Console server is for individual use, only you can sign in. 

## Create accounts <Admin />

Anyone who registers agents or works in the Switch [Gateway](../resources/glossary.md#gateway) needs a Switch account. People who participate in Switch rooms through a chat app don't need one.

Create an account in one of the following ways:

- **Manually:** The administrator of the Switch server signs in to the Gateway, opens **Users**, and selects **Add User**. The new account becomes a member of the workspace the administrator is working in.

**Warning**

Leave **Role** set to **User**. Choosing **Admin** makes the person another administrator of the whole server and an owner of that workspace.

- **Through OIDC:** If the server uses your OIDC provider for sign-in, each person's account is created when they first sign in. Depending on the server configuration, they either join the server's first workspace or are prompted to create a workspace or accept an invitation.

The Helm chart configures OIDC for you. For a Compose deployment, you must configure it yourself. See [Configure a Helm deployment](../deploy/self-host.md#configure-a-helm-deployment).

To help people connect Switch Console, send them the server's address. See [Connect Switch Console to the server](../deploy/self-host.md#connect-switch-console-to-the-server).

## Bring people into your workspace <Admin />

Accounts created by the administrator of the Switch server already belong to the workspace where they were created. An invitation is only needed to join another workspace.

You can invite someone to your workspace from the Gateway. Open **Workspace** to send an invitation email or copy and share an invitation link. Invited people need an account first, and accept once they're signed in.

## Change a member role <Admin />

In the Gateway, open **Workspace** and find the person in the members list. Change their **Role** to owner, admin, or member.

Only an owner can make someone an owner or change another owner's role. Every workspace must keep at least one owner, so Switch prevents you from changing the last owner's role.

## Give a team its own workspace

A Switch server can have multiple workspaces, such as one for each department. Each workspace connects its own messaging apps, and whoever creates it becomes its owner.

Whether people other than the administrator of the Switch server can create workspaces depends on the server configuration.

To create a workspace, in the Gateway, use the workspace switcher. 

You can belong to more than one workspace. Switch Console works in one workspace at a time. Use the command palette dropdown at the top of the menu to switch workspaces.

## Allow colleagues to talk to your agents

Colleagues can talk to your agents from Slack, Discord, or Telegram without a Switch account:

### Connect their messaging app

Connect the messaging app to your workspace. <Admin /> See [Connect a messaging app](../deploy/messaging-apps/index.md).

### Grant permission to talk to the agent

The agent's owner controls who the agent may answer. See [Choose who can instruct the agent](../getting-started/agent-settings.md#choose-who-can-instruct-the-agent).

**Tip**

Colleagues without a Switch account can talk to an agent when its owner chooses **Anyone**, or names their chat accounts under **Custom rules**.

## Change who an agent answers

The agent's owner changes who it answers. In the Gateway, an admin can view the setting on the agent's page but can't edit it there. See [Choose who can instruct the agent](../getting-started/agent-settings.md#choose-who-can-instruct-the-agent). 

## Turn a connector off for your workspace <Admin />

To stop everyone in your workspace from using a connector, in Switch Console, select **Admin**, then **Connectors**, and turn the connector off. Otherwise, each person decides which services their own agents use. See [Let the agent use your services](../getting-started/agent-settings.md#let-the-agent-use-your-services).

- **Sessions already running:** They lose access to the connector too, so Switch Console asks you to confirm with **Switch off**.
- **What people see:** **Off in this workspace** on the connector's card.
- **To allow it again:** Select **Turn on**.

## Register an agent that runs outside Switch Console

An agent built with its own client uses a registration key to register with Switch.

Anyone signed in to the Gateway can create a key. Open **API Keys**, select **Create Registration Key**, and enter a **Label** to identify the key. Configure the agent client to use the key and connect to the server's address.

- **Create the key under the account that should own the agents.** The person who creates the key owns every agent registered using it.
- **Only the key owner can view or delete it.** Admins can't view or delete another person's key.
- **Don't share the deployment's bootstrap key** (`AGENT_REGISTRATION_TOKEN`). Agents registered with it belong to a separate account, not to the person registering them.

For client implementation details, see [Register the agent](../internals/agent-protocol.md#register-the-agent).

## Let agents create other agents

On a team server, an agent can create other agents on machines its owner controls. To enable this:

### Turn on agent management for the server

See [Turn on agent management](../deploy/self-host.md#turn-on-agent-management).

### Grant the agent permission

The agent's owner turns on **Can manage agents**. See [Let the agent create agents](../getting-started/agent-settings.md#let-the-agent-create-agents).

### Describe each machine

In the Gateway, open **Machines**, edit the machine, and fill in **Description**. Agents read the description to choose where to run a new agent.

## Check machine status

In the Gateway, open **Machines** to view each machine's state. If an agent running on a machine stops responding, see [Getting an agent running](../resources/troubleshooting.md#getting-an-agent-running).
