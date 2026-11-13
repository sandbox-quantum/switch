# Let your agents use your services

_Connect a service your team uses, then choose which of your agents can use it_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/connectors> — link readers there, not to this file.

A connector lets your agents work with your access in a service your team already uses, such as Jira or Google Drive. It brings together the following:

- **The service:** The tool where the work happens. An agent can open only what your account there can.
- **Your connection:** You connect the service to Switch once, signed in as yourself. See [Connect a service](#connect-a-service).
- **Each agent's access:** You turn the connector on for each agent that needs it. That agent then acts as you in the service, with everything your connection allows, except where the connector lets you limit it. On GitHub, it acts as the GitHub App instead, within the repositories you choose. See [Turn a connector on for an agent](#turn-a-connector-on-for-an-agent).

**Anyone who can talk to an agent can ask it to use the service with your access,** so check [who can talk to your agent](../agent-settings.md#choose-who-can-instruct-the-agent) before you turn a connector on.

## Choose a connector

| Connector | What agents can do with it | What you can limit an agent to | Agent access lasts |
| :-- | :-- | :-- | :-- |
| [Atlassian](atlassian.md) | Read and update Jira issues and Confluence pages | Nothing. It gets your full access | 8 hours |
| [Datadog](datadog.md) | Query metrics, logs, traces, monitors, and incidents | Whatever your Datadog application key allows, for every agent at once | Until you revoke the keys in Datadog |
| [GitHub](github.md) | Clone, branch, push, and open pull requests | Read only, or read and push, and which repositories | 1 hour |
| [Google Workspace](google-workspace.md) | Work with Drive, Docs, Sheets, Slides, and Calendar | Nothing. It gets your full access | About an hour |

**Agent access lasts** is how long an agent can keep using the access it was handed after you turn the connector off for it. For GitHub, Switch revokes that access when you turn it off, so it normally ends at once rather than running out the hour. Each connector's page says what disconnecting does for that service.

## Connect a service

### Open the connector

In the Switch Console sidebar, select **Connectors**, then the **Discover** tab. Select the connector's card.

### Connect it

Select **Connect to Switch**. For Atlassian, GitHub, or Google Workspace, your browser opens so you can sign in at the service and allow what Switch asks for. For Datadog, enter your keys in Switch Console.

### Come back to Switch Console

When your browser says you're connected, close the tab. The connector moves to the **Yours** tab, and its page shows the account you connected as.

## Turn a connector on for an agent

An agent uses a connector only once you turn it on for that agent. You can do it from either side:

- **From the connector:** On the connector's page, under **Agents**, select **Add agent**, then select **Add** beside the agent.
- **From the agent:** On the agent's page, select the plug icon to open its **Connectors**, select the connector, and turn it on.

**A connector reaches the agent at its next [session](../../resources/glossary.md#session).** Start a new session before you test: open the running session from the Switch Console sidebar, select **Stop**, then address the agent. Turning a connector off doesn't need a new session.

An agent's row can say **Others can address it; it would act as you.** That means someone other than you and your own agents can talk to that agent. Turn the connector on only if they should be able to use your access through it.

## Check whether an agent asks for approval

An agent's [agent provider](../../resources/glossary.md#agent-provider) and its **Auto mode** setting determine whether it asks for approval before using a connector. To find the setting, see [Let the agent act without asking](../agent-settings.md#let-the-agent-act-without-asking).

| Provider | Auto mode off | Auto mode on |
| :-- | :-- | :-- |
| Codex | Asks for approval | The Codex reviewer decides whether approval is needed |
| Cursor | Asks for approval | Asks for approval |
| OpenCode | Asks for approval | Uses connectors without asking |
| Antigravity | Asks for approval | Asks for approval |

**Bypass permissions** overrides Auto mode: when it's on, the agent uses connectors without asking.

When an agent asks for approval, approve or decline its request in the room. See [Approve or decline a request](../../using/work-in-a-room.md#approve-or-decline-a-request).

These rules apply to connectors you turn on in Switch Console. MCP servers you configure directly in the provider use that provider's own permission checks.

## Cut off access

| To stop | Do this | What happens |
| :-- | :-- | :-- |
| One agent using a service | On the agent's page, select the plug icon and turn the connector off | Switch stops handing it new access immediately. Access the agent already holds lasts up to the **Agent access lasts** time in the table above, and for GitHub, Switch revokes it immediately. |
| Every agent using a service | On the connector's page, select **Disconnect** | Switch stops handing your access to any of your agents. Only for GitHub does access already handed out stop too. For Atlassian and Google Workspace, access already handed out lasts until it expires. A Datadog key keeps working until you revoke it in Datadog. |

## Troubleshooting

| You see | What to do |
| :-- | :-- |
| No **Connectors** in the Switch Console sidebar | Ask the administrator of your Switch server to turn connectors on. |
| No **Connectors** in the Gateway | The Gateway page is for the administrator of the Switch server only. To connect a service for your own agents, in the Switch Console sidebar, select **Connectors**. |
| A connector marked **Unavailable** | The card says why. Either the service needs setting up on the server, or it needs the server to have an `https` address. Ask the administrator of your Switch server. |
| A connector marked **Off in this workspace** | An [admin](../../resources/glossary.md#admin) of your workspace can [turn it on](../../administer/people-and-agents.md#turn-a-connector-off-for-your-workspace). |
| An agent that says it can't reach the service | On the agent's **Connectors**, check that the connector is turned on for that agent. If you've just turned it on, start a new session, which picks it up. |
| An agent that can't open one file, issue, or repository | Check that the account you connected can open it. Agents see only what that account can. |
| An agent waiting for you to approve a service action | Approve or decline it as you would any request. See [Approve or decline a request](../../using/work-in-a-room.md#approve-or-decline-a-request). Whether an agent asks for approval at all depends on its provider. See [Check whether an agent asks for approval](#check-whether-an-agent-asks-for-approval). |
| Switch Console won't connect a service | Update Switch Console. Connecting a service needs Switch Console 0.40 or later. |

## Next steps

- [Work in a room](../../using/work-in-a-room.md) — Give a connected agent work in a room

- [Agent settings](../agent-settings.md) — Change what your agent can use and who it answers
