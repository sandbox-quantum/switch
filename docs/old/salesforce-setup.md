# Salesforce on a self-hosted server

Agents can read and update Salesforce records in their owners' Salesforce
orgs once the server's operator creates an External Client App in a
Salesforce org. Each person then connects their own Salesforce account from
Switch Console and turns Salesforce on for the agents they choose.

The connection covers the org's hosted MCP servers `sobject-reads` (read
only) and `sobject-mutations` (create and update; no deletes). It signs
people in through `login.salesforce.com`: production and Developer Edition
orgs work, sandbox orgs (`test.salesforce.com`) and My Domain orgs with
shared login disabled do not.

## What you need

- A Salesforce org where you are an admin. A free Developer Edition org
  works for trying this out. Whoever owns the External Client App can edit
  or delete it, and deleting it stops every connection on the server, so
  prefer an org service account over one person's.
- The server's **`GATEWAY_PUBLIC_URL`**, if sign-ins should come back to
  Switch over the server's own address. Without it, only the loopback
  redirect (Switch Console's own listener) is registered.

## Turn the MCP servers on

Hosted MCP servers are off by default. In Setup, open **API Catalog**, then
**MCP Servers**, and activate **SObject Reads** and **SObject Mutations**.

Salesforce meters hosted MCP usage (Flex Credits may apply, per your
edition); check your org's terms before enabling the servers for everyone.

## Create the External Client App

In Setup, open **External Client App Manager**, then **New External Client
App**:

1. **Name** it as people should see it, for example "Switch".
2. Under **API (Enable OAuth Settings)**, check **Enable OAuth**.
3. **Callback URL**: register every one of these, exactly, port included:
   ```
   http://localhost:39251/switch-services/callback
   http://localhost:39252/switch-services/callback
   http://localhost:39253/switch-services/callback
   http://localhost:39254/switch-services/callback
   http://localhost:39255/switch-services/callback
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/salesforce/flows/callback
   ```
   Salesforce registers no IP-literal http callback ("Cannot be an HTTP
   URL"); the `localhost` name is the only loopback it takes. Leave the
   last one out where the server has no public URL. Salesforce sends
   people back only to a registered URL, matched exactly, so if the
   public URL changes, change it here too, or sign-ins fail.
4. **OAuth Scopes**: add **Access Salesforce hosted MCP servers
   (`mcp_api`)**, **Perform requests at any time (`refresh_token`,
   `offline_access`)** and **Access unique user identifiers (`openid`)**.
5. Under **Security**, check **Require Proof Key for Code Exchange (PKCE)**
   and **Issue JSON Web Token (JWT)-based access tokens for named users**,
   and uncheck the secret requirements for the web server and refresh token
   flows. MCP calls fail after sign-in (`INVALID_JWT_FORMAT`) unless JWT
   tokens are on. Enable **Refresh Token Rotation** to match this entry's
   `refresh: rotating` policy; a successful refresh must save the replacement
   token. Confirm this behavior during live QA rather than assuming a token
   is reusable.
6. Create the app. It can take up to 30 minutes to become usable. Then open
   **Settings**, **Consumer Key and Secret**, and copy the **Consumer Key**.

## Give Switch the client

Write the consumer key to a JSON file on the server, readable only by the
Core process:

```json
{ "client_id": "<consumer key>" }
```

Point Core at it with `SALESFORCE_CLIENT_CONFIG_PATH` and restart Core. A
person's sign-in uses PKCE and no client secret; the consumer key identifies
the app to Salesforce.

## What people do

Each person opens Switch Console, picks Salesforce and signs in with their
own Salesforce account. Salesforce shows them the app's consent screen; the
connection then runs with their own permissions, field-level security and
sharing rules. This is a write-capable connection: the mcp_api scope cannot enforce
read-only consent. Switch passes through Salesforce's tools, subject to the
person's permissions and the org's activated servers. Turning the connection
on for an agent is not approval for a particular record change.

Disconnecting in Switch revokes the sign-in at Salesforce. People can also
remove the app under their Salesforce account's connected-app settings; an
admin can block it for the whole org in the External Client App's policies.

## Local QA evidence and remaining checks

Developer Edition live QA completed the client-ID-only PKCE sign-in and
identified the connected account. A granted room agent completed
`salesforce-reads.getUserInfo` and `getObjectSchema`; after its grant was
removed, a fresh request reported the tool unavailable. These were read-side
calls, not a record-write test. The connection remains honestly write-capable.

Metadata-only inspection observed a two-hour issued access window. After the
original expiry, a fresh getUserInfo completed without another sign-in, and
metadata showed an active connection with a later issued access expiry. This
verifies renewal, not the number of refreshes or refresh-token value rotation.
Disconnect and the timed grant-off video remain pending.

The existing org has SObject Reads and Mutations active, Deletes and All
inactive. Salesforce's Developer Edition announcement states Hosted MCP is
included at no cost; general production billing warnings still apply to
other editions. No paid plan, hold or upgrade was used.

Sources:
- https://developer.salesforce.com/blogs/2026/04/new-developer-edition-agentforce-vibes-claude-mcp
- https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/sobject-reads.html

Console validates the exact loopback listener callback with either
`127.0.0.1` or `localhost`, preserving its port, path, state, vendor HTTPS
and Core-origin checks. Salesforce registers the latter name.
