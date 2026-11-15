# Connect Atlassian

_Let your Switch agents read and update Jira issues and Confluence pages as you_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/connectors/atlassian> — link readers there, not to this file.

With Atlassian connected, your agents can read and update Jira issues and Confluence pages as you. One connection covers both. For how connectors work across services, see [Let your agents use your services](index.md).

## Before you begin

- **Connectors turned on for your server.** Atlassian needs no other setup on the server.
- **The Atlassian account you want agents to use.** Agents act as that account, in every Jira project and Confluence space it can reach. There's no read-only option for Atlassian.
- **Whether the agent asks for approval.** It depends on the agent's provider and settings. See [Check whether an agent asks for approval](index.md#check-whether-an-agent-asks-for-approval).

## Connect Atlassian

### Start the connection

In the Switch Console sidebar, select **Connectors**, then the **Discover** tab. Select **Atlassian**, then **Connect to Switch**. Your browser opens, and Switch Console waits while you sign in.

### Sign in and allow access

Sign in at Atlassian with the account your agents should use, and allow what Switch asks for.

### Return to Switch Console

When the page says you're connected, close the tab. The Atlassian page in Switch Console shows the account you connected as.

Then turn Atlassian on for each agent that needs it. See [Turn a connector on for an agent](index.md#turn-a-connector-on-for-an-agent). To check it works, start a new [session](../../resources/glossary.md#session) with the agent, then ask it something small, such as *list my open Jira issues*.

**Rovo search isn't included.** Switch doesn't ask for Atlassian's Rovo search, because each search spends Rovo credits for your organization.

## Cut off access

**To stop one agent,** open the agent's page, select the plug icon, and turn Atlassian off. **To stop every agent,** on the Atlassian page under **Connectors**, select **Disconnect**.

- **Access already handed out lasts up to eight hours.** After you turn Atlassian off for an agent, access the agent already holds keeps working for up to eight hours.
- **Disconnecting removes the sign-in Switch holds for your Atlassian account.** Switch stops handing out new access. Access an agent already holds keeps working until it expires, up to eight hours.
- **To end access sooner,** in your Atlassian account's connected apps, remove the access you gave Switch.

## Next steps

- [Let your agents use your services](index.md) — Connect another service, or check how approvals and cutting off access work
