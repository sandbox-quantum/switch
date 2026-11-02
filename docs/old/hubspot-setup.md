# HubSpot on a self-hosted server

Agents can read and update HubSpot contacts, companies and deals in their
owners' HubSpot accounts once the server's operator creates a HubSpot MCP
connector. Each person then connects their own HubSpot account from Switch
Console and turns HubSpot on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Adding a connector.

Without the connector, HubSpot is listed on the server as not set up.

## What you need

- A **HubSpot account** to own the MCP connector, on HubSpot's current
  Developer Platform. Use one that belongs to the organization rather than
  to one person: whoever owns the connector can edit or delete it, and
  deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**, if sign-ins should come back to
  Switch over the server's own address. Without it, only the loopback
  redirect (Switch Console's own listener) is registered.

## Create the MCP connector

In HubSpot, open **Development**, then **MCP Connectors**, then **Create MCP
connector**:

1. **Name** it as people should see it, for example "Switch".
2. **Redirect URLs**: register every one of these, exactly, port included:
   ```
   http://127.0.0.1:39241/switch-services/callback
   http://127.0.0.1:39242/switch-services/callback
   http://127.0.0.1:39243/switch-services/callback
   http://127.0.0.1:39244/switch-services/callback
   http://127.0.0.1:39245/switch-services/callback
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/hubspot/flows/callback
   ```
   Leave the last one out where the server has no public URL. HubSpot sends
   people back only to a registered URL, matched exactly, so if the public
   URL changes, change it here too, or sign-ins fail.
3. Create the connector. On its details page, copy the **Client ID** and the
   **Client secret**; HubSpot shows the secret once.

HubSpot does not let the operator define the connector's scopes: they follow
the server's tools and the permissions each person grants at install. Switch
asks for the least set that covers contacts, companies and deals, with
`account-info.security.read` only so it can say whose account connected.

## Give Switch the client

Write the connector's client id and secret to a JSON file on the server,
readable by switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
HUBSPOT_CLIENT_CONFIG_PATH=/etc/switch/hubspot-client.json
```

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, HubSpot, Connect. The browser
   opens HubSpot; the person picks their HubSpot account, grants the
   permissions, and comes back.
2. They turn HubSpot on for an agent. The agent's HubSpot tools work as that
   person, within the access they granted.

A connection lasts until the person disconnects it or the connector's
owner deletes or revokes it. Disconnecting in Switch stops Switch using the
sign-in at once; HubSpot keeps it authorized until the person uninstalls
Switch under Settings, Integrations, Connected Apps.
