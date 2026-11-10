# Salesforce on a self-hosted server

Agents can read, create and update Salesforce records once the server's
operator creates a Salesforce External Client App. Each person then connects their own Salesforce account from Switch
Console and turns Salesforce on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Salesforce.

Without the app, Salesforce is listed on the server as not set up.

## What you need

- A **Salesforce org** where you can open Setup. It has been tried with a
  Developer Edition org; production orgs follow the same setup but have not
  been tried yet. Sandboxes and scratch orgs do not work, and neither do orgs
  that block sign-in through `login.salesforce.com`.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Salesforce sends people back to Switch there; without it, Salesforce cannot
  be set up.

Salesforce may meter its hosted MCP servers in Flex Credits. Check what your
contract says before you turn them on.

## Enable the MCP server

In Setup, open **API Catalog**, then **MCP Servers**, and activate **SObject
Mutations**. It queries, searches, creates and updates records, and cannot
delete one.

Leave **SObject Deletes** and **SObject All** off. Switch never connects to
them, and with them off, no Salesforce MCP tool a Switch user's token reaches
deletes a record. Switch does not use **SObject Reads**, so it can stay
off too.

## Create the External Client App

In Setup, open **External Client App Manager**, then **New External Client
App**. Connected Apps do not work with hosted MCP servers.

1. Fill in **Basic Information**.
2. Under **API (Enable OAuth Settings)**, select **Enable OAuth**.
3. **Callback URL**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/salesforce/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
4. **OAuth Scopes**: exactly these three.
   - Access Salesforce hosted MCP servers (`mcp_api`)
   - Perform requests at any time (`refresh_token, offline_access`)
   - Access unique user identifiers (`openid`)
5. Under **Security**, select **Issue JSON Web Token (JWT)-based access tokens
   for named users** and **Require Secret for Web Server Flow**. Hosted MCP
   servers take only JWT-based tokens.
6. **Create** the app. It can take up to 30 minutes to start working, and may
   work on some attempts and not others until then.
7. Under **Policies**, click **Edit**, open **OAuth Policies**, and under
   **Named User JWT-Based Access Token Settings** choose **Set app-specific token
   timeout** and **30 Minutes**. Save. Without this, tokens last as long as the
   org's session timeout, and Switch refuses any that last longer than 30
   minutes.
8. Under **Settings**, **OAuth Settings**, click **Consumer Key and Secret**,
   enter the code Salesforce emails you, and copy both. The Consumer Key is the
   client ID.

New apps have **Refresh Token Rotation** on and refresh tokens that lapse after
30 idle days, so someone who leaves their connection idle for that long connects
again.

To limit who can connect, require a permission set under **OAuth Policies**.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Salesforce**. The dialog walks
the steps above, with the callback URL to copy and the scopes to add; paste the
**Consumer Key** as the Client ID and the **Consumer Secret** as the Client
secret, tick that the server and tokens are set, and choose **Check and save**.
Switch first asks Salesforce about the client, and saves it only if Salesforce
accepts it. That cannot show the callback URL, the JWT or timeout settings, or
whether the server is active, so connect once and use a Salesforce tool from a session
to confirm them. The secret is stored encrypted, like every other stored
credential (see [key rotation](key-rotation.md)), and is in use at once.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the client id and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<consumer key>", "client_secret": "<consumer secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with an
absolute path and restart it:

```bash
SALESFORCE_CLIENT_CONFIG_PATH=/etc/switch/salesforce-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.salesforceClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, Salesforce, Connect. The browser
   opens Salesforce's sign-in and consent page, and comes back to Switch.
2. On an agent's Connectors, turn Salesforce on. The agent can then read,
   create and update records as that person, and everything it does shows in
   Salesforce as done by them.

### What a grant reaches

Salesforce has no read-only sign-in: its `mcp_api` scope reaches every tool of
every MCP server the org activated. So a Salesforce connection is always a
write connection, and a grant is on or off, with no reading-only level. An
agent reaches only what its owner's object permissions, field-level security
and sharing rules allow, so to keep an agent from changing something, connect
with a Salesforce user that cannot change it. The skill Switch gives agents has
them confirm each change before making it, but that is guidance, not a limit.

Turning a grant off stops it within a minute, in running sessions too. A token already
handed out stays valid at Salesforce until it expires, at most 30 minutes.
Disconnecting revokes the sign-in at Salesforce.

## Troubleshooting

- **Salesforce's token lasts longer than Switch allows**: set the 30-minute
  timeout under **OAuth Policies**, then connect again.
- **Connecting works, but Salesforce tools refuse the token**: the app does not
  issue JWT-based access tokens. Select the setting under **Security**.
- **Salesforce's sign-in refuses the redirect**: the Callback URL is not exactly
  the server's. It must match `GATEWAY_PUBLIC_URL`.
- **Connecting works, but an agent has no Salesforce tools**: SObject Mutations
  is not active under **API Catalog**, or the app is still within its 30 minutes.

To switch Salesforce off, add it to `DISABLED_SERVICES`, e.g.
`DISABLED_SERVICES='{"salesforce": "Paused while we review access."}'`, or
remove its client under Connector apps.
