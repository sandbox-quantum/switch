# Salesforce on a self-hosted server

Agents can read, query, create and update their owners' Salesforce records once a
Salesforce admin creates an External Client App and the server's operator saves
it. Each person then connects their own Salesforce user from Switch Console and
turns Salesforce on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Salesforce.

Without the app, Salesforce is listed on the server as not set up.

## What you need

- A **Salesforce org** with hosted MCP servers, and an admin. A free Developer
  Edition org is enough to try it.
- The server's **`GATEWAY_PUBLIC_URL`**: people are sent back to the server's
  own callback, which Salesforce matches exactly.

## Enable the MCP server

In Setup, type `MCP` in Quick Find, open the MCP Servers page, and enable
**SObject Mutations** (`platform/sobject-mutations`): create, read, update and
query, with no delete tool. Leave **SObject All** and **SObject Deletes** off.

## Create the External Client App

Connected Apps don't work with hosted MCP servers. In Setup, type
`external client` in Quick Find, open **External Client App Manager**, and choose
**New External Client App**:

1. Fill in the basic information. **Distribution State** stays **Local**.
2. Under **API (Enable OAuth Settings)**, tick **Enable OAuth**.
3. In **Callback URL**, enter the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/salesforce/flows/callback
   ```
4. Under **OAuth Scopes**, add **Access Salesforce hosted MCP servers
   (mcp_api)**, **Perform requests at any time (refresh_token)** and **Access
   unique user identifiers (openid)**.
5. Under **Security**, tick **Require Proof Key for Code Exchange (PKCE)**,
   **Require Secret for Web Server Flow** and **Issue JSON Web Token
   (JWT)-based access tokens for named users**.
6. Create the app. From its **Settings**, copy the **Consumer Key** and
   **Consumer Secret**.

Salesforce says a new app can take 30 minutes to start working. Under **OAuth
Policies**, Salesforce recommends a refresh token validity of 30 days or less
and refresh token rotation; Switch handles either.

## Give Switch the app

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Salesforce**. The dialog walks the
steps above; paste the **Consumer Key** as the client ID and the **Consumer
Secret** as the client secret, and choose **Check and save**.

Salesforce answers Switch's check the same way whether the secret is right or
not (`unknown_error`), so the check can only refuse a consumer key Salesforce
does not know (`invalid_client_id`). Otherwise Switch saves the app unchecked,
says so, and the first sign-in checks the secret and the callback URL: connect
once to confirm. The secret is stored encrypted, like every other stored
credential (see [key rotation](key-rotation.md)), and is in use at once.

### Or, from configuration

The app can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, an app saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write it to a JSON file on the server, readable by switch-core alone and never
committed anywhere:

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

## What people do

1. In Switch Console: Settings, Connections, Salesforce, Connect. The browser
   opens Salesforce's sign-in and consent page and comes back to the server.
2. On an agent's page, the agent's owner turns Salesforce on. The agent acts as
   its owner: what it creates or updates shows in Salesforce as done by them, and
   their permissions, field-level security and sharing apply.
3. Disconnecting revokes the sign-in at Salesforce, and every agent loses
   Salesforce at once.

## Switching it off

Any of these lists Salesforce as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"salesforce": "Paused while we review access."}'`;
- remove its app under Connector apps;
- unset `SALESFORCE_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- A connection reads and writes: `mcp_api` reaches whatever SObject Mutations
  does. It cannot delete records.
- A granted agent's token is its owner's own; turning an agent off stops its
  sessions using Salesforce within a minute, and a token already handed out stays
  valid at Salesforce until it expires, up to 2 hours, or until the owner
  disconnects.
- Hosted MCP calls may count against the org's Flex Credits, depending on its
  licences.
