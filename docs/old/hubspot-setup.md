# HubSpot on a self-hosted server

Agents can read and update HubSpot contacts, companies and deals once the
server's operator creates an MCP connector app. Each person then connects their
own HubSpot account from Switch Console and turns HubSpot on for the agents
they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under HubSpot.

Without the app, HubSpot is listed on the server as not set up.

Enable service connections with `FEATURE_FLAGS_ENABLED=service_connections`.

## What you need

- A HubSpot account where you can create an MCP connector app.
- The server's `GATEWAY_PUBLIC_URL`, which must be HTTPS. HubSpot sends people
  back to Switch's callback on this address.

## Register the MCP connector app

In HubSpot, create an **MCP connector** app and register this exact OAuth
redirect URL:

```
<GATEWAY_PUBLIC_URL>/gateway/service-connections/hubspot/flows/callback
```

HubSpot's MCP server does not let the operator select OAuth scopes. Its tools
and the connecting person's HubSpot permissions determine access. The account
permissions are the boundary; a HubSpot connection can write wherever that
person can write.

## Give Switch the app

In Switch Console, open **Admin** and **Connector apps**. With the
`service_connections` feature enabled, choose **Set up HubSpot**, enter the
app's Client ID and Client secret, and choose **Check and save**. The app is
stored encrypted and takes effect immediately.

The app can instead be configured from a JSON file on the server, readable by
switch-core alone and never committed:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

Set `HUBSPOT_CLIENT_CONFIG_PATH` to the file's absolute path and restart
switch-core. Configuration takes precedence over an app saved in the dashboard.

## What people do

1. In Switch Console, open **Settings**, **Connections**, **HubSpot**, then
   **Connect**. The browser opens HubSpot's authorization page and returns to
   Switch.
2. Grant HubSpot to an agent. The agent's tools are limited by the connected
   person's HubSpot permissions and the MCP tools HubSpot makes available.
3. Before changing CRM records, the agent reads the matching record and
   confirms the requested change with the user.

HubSpot's MCP authorization metadata does not advertise a revocation endpoint.
Disconnecting in Switch stops Switch from using the connection, but does not
revoke the vendor authorization. Remove the Switch connected app from HubSpot
account settings to revoke it there; the exact navigation has not been
confirmed against a live account.

HubSpot's general OAuth documentation gives access tokens a 30-minute
expiration. The MCP authorization server uses a separate token endpoint, so
verify its actual expiry during the first live connection. Switch caps tokens
handed to agents at 30 minutes and refreshes the connection automatically.

To disable HubSpot on the server, add `hubspot` to `DISABLED_SERVICES`, remove
the app under **Connector apps**, or unset `HUBSPOT_CLIENT_CONFIG_PATH`.
