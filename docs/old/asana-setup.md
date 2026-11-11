# Asana on a self-hosted server

Agents can read and update tasks, projects, stories and comments in their owners'
Asana workspaces once the server's operator registers an Asana OAuth app. Each
person then connects their own Asana account from Switch Console, and turns Asana
on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Service connections: v2.

Without the OAuth app, Asana is listed on the server as not set up.

## What you need

- An **Asana account** to own the app. Use one that belongs to the organization
  rather than to one person: whoever owns the app can edit or delete it, and
  deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Asana sends people back to Switch there; without it, Asana cannot be set up.

## Register the app

In Asana, open **Developer Console** (`https://app.asana.com/0/my-apps`), then
**Create new app**:

1. **Name** it as people should see it on Asana's consent page, for example
   "Switch".
2. **OAuth redirect URL**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/asana/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
3. Under **OAuth**, copy the **Client ID** and **Client secret**.

## Scopes and Identity

Asana's official remote MCP server (`https://mcp.asana.com/v2/mcp`) does not
use individual OAuth scopes; access is determined by the authorizing user's
existing workspace permissions (`access: { unscoped: true }`). Because MCP-app
tokens are restricted to MCP calls and cannot query Asana's REST API, identity
is resolved through the MCP server's `get_user` tool (`identity.mcp_tool`).

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Asana**. The dialog walks
the steps above, with the redirect URL to copy; paste the app's **Client ID**
and **Client secret**, and save.

Switch checks the client against Asana and saves it. If the server is not
ready to connect, the dialog says what is missing.

### Or in configuration

Alternatively, name the client in the server's environment:

```bash
ASANA_CLIENT_CONFIG_PATH=/etc/switch/asana-client.json
```

Where the file holds the credentials as JSON:

```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

A client saved in the dashboard takes precedence over this file. For Helm,
pass the secret via `switchCore.asanaClientSecret`.

