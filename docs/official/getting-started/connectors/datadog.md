# Connect Datadog

_Let your Switch agents query Datadog metrics, logs, traces, monitors, and incidents with your keys_

Published at <https://docs.switchagents.ai/switch-rooms/getting-started/connectors/datadog> — link readers there, not to this file.

With Datadog connected, your agents can query Datadog metrics, logs, traces, monitors, and incidents, using your keys. For how connectors work across services, see [Let your agents use your services](index.md).

## Before you begin

- **Connectors turned on for your server.** Datadog needs no other setup on the server.
- **MCP access turned on for your Datadog organization,** in Datadog under **Organization Settings**, then **Preferences**. Without it, Datadog connects but your agents' requests fail.
- **A Datadog API key and application key,** and the Datadog site your organization uses, such as `datadoghq.com` or `datadoghq.eu`. Give the application key the `mcp_read` scope, and add `mcp_write` only if agents should change things in Datadog.
- **Whether the agent asks for approval.** It depends on the agent's provider and settings. See [Check whether an agent asks for approval](index.md#check-whether-an-agent-asks-for-approval).

## Connect Datadog

### Open the connection form

In the Switch Console sidebar, select **Connectors**, then the **Discover** tab. Select **Datadog**, then **Connect to Switch**.

### Enter your keys

Enter your API key and application key, and choose your Datadog site. Switch checks the API key when you submit. It doesn't check the application key, so a wrong one shows up only when an agent first uses Datadog.

Then turn Datadog on for each agent that needs it. See [Turn a connector on for an agent](index.md#turn-a-connector-on-for-an-agent). To check it works, start a new [session](../../resources/glossary.md#session) with the agent, then ask it something small, such as *show me the monitors that are alerting*.

## Cut off access

**To stop one agent,** open the agent's page, select the plug icon, and turn Datadog off. **To stop every agent,** on the Datadog page under **Connectors**, select **Disconnect**.

- **The keys don't expire.** When you turn Datadog off for an agent, Switch stops handing it your keys immediately, but keys it already holds keep working until you revoke them in Datadog.
- **Revoke both keys in Datadog to stop them everywhere,** the API key and the application key. Disconnecting makes Switch forget your keys, but only Datadog can revoke them.

## Troubleshooting

### Datadog is connected but every request fails

**MCP access is probably off for your Datadog organization.** In Datadog, open **Organization Settings**, then **Preferences**, and turn it on. If it's already on, check the application key: Switch doesn't check it when you connect.

## Next steps

- [Let your agents use your services](index.md) — Connect another service, or check how approvals and cutting off access work
