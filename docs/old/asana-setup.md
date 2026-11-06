# Asana on a self-hosted server

> **Verification pending:** The connector identifies the account through an
> MCP tool. The tool's current read-only annotation and full schema have not
> been verified, and agent grants may persist when the same person changes
> Asana workspaces. See the limits below.

Agents can read and update tasks and projects in the Asana workspace their
owner selects when authorizing the connection, within that owner's Asana
permissions, once the server's operator registers an Asana MCP app. Each
person then connects their own Asana account from Switch Console and turns
Asana on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md).

Without the app, Asana is listed on the server as not set up. Asana offers
no dynamic registration for its MCP server, so there is no way around
registering one: a client must exist before anyone can connect.

## What you need

- An **Asana account** to own the app. Use one that belongs to the
  organization rather than to one person: whoever owns the app can edit or
  delete it, and deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch
  at. Asana sends people back to Switch there, as Airtable and Google
  Workspace do; without it, Asana cannot be set up.

Use the standard server, `https://mcp.asana.com/v2/mcp`. Asana also offers
a Command MCP server; it is separately licensed per user and is not the
one this connection uses.

## Register the app

In Asana's [developer console](https://app.asana.com/0/my-apps), choose
**Create new app**:

1. **App type: MCP app.** This is a choice Asana asks for at creation, and
   it cannot be changed later. A standard API app's sign-ins are not the
   ones the MCP server takes.
2. Name it as people should see it on Asana's consent page, for example
   "Switch".
3. Under **OAuth**, add the **Redirect URL**, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/asana/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
4. Under **Manage distribution**, choose who may authorize the app:
   **Any workspace**, or **Specific workspaces** with at least one
   workspace selected. Specific workspaces with an empty list refuses
   everyone, at Asana's consent page, with nothing wrong in Switch.

There are no permission scopes to pick. Asana's integration guide permits
`default` or an omitted scope and says every authorization may use every
tool the server offers, within the selected workspace and the person's own
Asana permissions. [Asana's tool reference](https://developers.asana.com/docs/mcp-tools-reference)
says each MCP session is scoped to one workspace selected at authorization.
The integration guide recommends omitting `scope` if it is rejected;
this connector omits it.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps**
under Server, or in the Switch dashboard open **Connectors** beside Users.
Both are shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Asana** and paste the app's
**Client ID** and **Client secret**. Switch first asks Asana about the
client, and saves it only if Asana accepts the two together. That check
cannot show the redirect URL or the app's distribution, so have someone
whose workspace the app allows connect once to confirm both. The secret is
stored encrypted, like every other stored credential (see
[key rotation](key-rotation.md)), and is in use at once: nobody needs to
restart anything.

### Or, from configuration

The client can be set in the server's configuration instead.
**Configuration wins**: while it is set, Switch uses it, a client saved in
the dashboard is ignored, and saving from the dashboard is refused.

Write the app's client id and secret to a JSON file on the server,
readable by switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it
with an absolute path and restart it:

```bash
ASANA_CLIENT_CONFIG_PATH=/etc/switch/asana-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.asanaClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why. To move a configured client into
the dashboard, choose **Manage it here instead** on its card, then remove
the variable and restart switch-core; it is the same client, so nobody
reconnects.

## What people do

1. In Switch Console: Settings, Connections, Asana, Connect. The browser
   opens Asana's consent page and comes back to Switch Console.
2. On Asana's page the person allows the app. The consent is not split
   into read and write, so every connection can write; what an agent
   reaches is narrowed by the person's own Asana permissions, not by the
   connection.
3. On an agent's page (in Switch Console or the dashboard), the agent's
   owner turns Asana on. The agent acts as its owner: tasks and comments
   it creates, changes or completes show in Asana as done by them.

Disconnecting revokes the sign-in at Asana: Core sends the refresh token
to Asana's revocation endpoint, which deauthorizes it and its access
tokens with it, and the app disappears from the person's authorized apps
in Asana.

## Switching it off

Any of these lists Asana as unavailable, with its reason, and stops
agents' next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"asana": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `ASANA_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- A user-only identity does not distinguish two Asana workspaces selected
  by the same person. Switch keeps existing agent grants on a reconnect to
  the same account. Until Switch can detect a change of Asana workspace,
  remove the existing agent grants before reconnecting to another Asana
  workspace and grant them again only after checking the new connection.
- Asana documents one-hour access tokens and a long-lived reusable refresh
  token. Refresh behavior has not been measured with this V2 MCP app. The
  adapter stores a replacement refresh token if the server returns one, and
  retains the existing token if it does not.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off
  stops its sessions within an hour; disconnecting stops every agent at
  once.
- Asana answers a token it no longer accepts — a revoked one, or one
  replaced by a reconnect — with a tool error (`{"error": "unauthorized"}`)
  rather than an HTTP 401. The session host asks Switch for a new token
  only on a 401, so a session already holding the old token keeps failing
  until that token's hour is up, or the agents controller restarts.
  Ordinary hourly renewal is not affected.
- Advanced task search (`search_tasks`) needs a paid Asana plan. On a free
  plan it is refused, and agents fall back to the basic task and project
  tools.
- The connector uses the resource advertised in protected-resource
  metadata. The server's protected-resource metadata identifies
  `https://mcp.asana.com/v2/mcp` as its resource, while Asana's integration
  guide gives `https://mcp.asana.com/v2` as an optional resource example.
  Acceptance of this resource value by this PR has not been
  verified with a real app and may prevent authorization.

## An organization's own Asana app

With the `organization_connector_apps` flag on (with
`service_connections`), an organization's admins can save its own under
**Organization**, **Connectors** in the dashboard, with the same callback,
checks and encryption as above. Every workspace in that organization then
signs in through the organization's app instead of the server's; the
others keep using the server's. If the organization's app stops working,
its workspaces see Asana as unavailable, with the reason, rather than
falling back to the server's. Removing it sends them back to the server's
app, and people connected through it reconnect once. The flag is off by
default.
