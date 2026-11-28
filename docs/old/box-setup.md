# Box on a self-hosted server

Agents can search, read and organize the files and folders their owners can
reach in Box once a Box admin turns on Box's MCP server and the server's
operator saves its Integration Credentials. Each person then connects their
own Box account from Switch Console and turns Box on for the agents they
choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Box.

Without the credentials, Box is listed on the server as not set up.

## What you need

- A **Box admin** for the enterprise whose people will connect. Box's MCP
  server (`https://mcp.box.com`) is an integration the admin enables, and
  its client ID and secret come from the Box Admin Console; Box offers no
  way for Switch to register itself. A Custom App with **User
  Authentication (OAuth 2.0)** made in the Box Developer Console also works,
  with the same redirect URI and scopes. A free Box developer account is
  its own enterprise, with its owner as admin, and is enough to try it.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Box sends people back to Switch there, as with Airtable and Google
  Workspace; without it, Box cannot be set up.

## Turn on the Box MCP server and add credentials

In the Box Admin Console, open **Integrations** and search for **Box MCP
server**:

1. Set its state so it is **enabled** for the people who will connect (all
   users, or a group).
2. Hover on **Box MCP server**, choose **Configure**, and under **Additional
   Configuration** choose **Add Integration Credentials**. Name the entry
   (for example "Switch") and save it.
3. Expand the new entry. Set its **Redirect URI** to the server's callback,
   exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/box/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
4. Under **Access Scopes**, allow reading and writing all files and folders
   (`root_readonly` and `root_readwrite`). These are the most a sign-in can
   be granted; each sign-in asks for one level's scope. Box AI
   (`ai.readwrite`) and Doc Gen (`docgen.readwrite`) are not asked for: Box
   AI spends the enterprise's AI units, and Doc Gen needs an Enterprise
   Advanced licence.
5. Copy the **Client ID** and **Client Secret**.

Some of the server's tools are off until an admin turns them on (moving and
renaming, metadata changes, new file versions, shared links, collaborations,
upload and download links); see Box's [available
tools](https://developer.box.com/guides/box-mcp/tools). Turn on only what
agents should do.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps**
under Server, or in the Switch dashboard open **Connectors** beside Users.
Both are shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Box**, paste the **Client
ID** and **Client secret**, and choose **Check and save**. Switch first asks
Box about the client, and saves it only if Box accepts the client ID and
secret together. That cannot show the redirect URI, the credentials' scopes,
or whether the MCP server is enabled for everyone who will connect, so
connect once to confirm. The secret is stored encrypted, like every other
stored credential (see [key rotation](key-rotation.md)), and is in use at
once: nothing needs restarting.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the client id and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
BOX_CLIENT_CONFIG_PATH=/etc/switch/box-client.json
```

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## Turn it on for a workspace

A workspace admin opens **Admin** in Switch Console and **Connectors** under
Workspace, and turns Box on; until then connecting Box is refused. This is
the workspace's own switch, separate from the operator's client under
Connector apps.

## What people do

1. In Switch Console, open **Connectors** in the workspace's sidebar, find
   Box, and choose **Connect**. The browser opens Box's sign-in and consent
   page and comes back to Switch Console.
2. On an agent's page, the agent's owner turns Box on. The agent acts as
   its owner: it sees only what they can open in Box, and what it uploads,
   copies or comments on shows in Box as done by them.

Disconnecting revokes the sign-in at Box, at the revocation endpoint Box
advertises.

## Switching it off

Any of these lists Box as unavailable, with its reason, and stops agents'
next credential requests:

- add it to `DISABLED_SERVICES` and restart switch-core, e.g.
  `DISABLED_SERVICES='{"box": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `BOX_CLIENT_CONFIG_PATH` and restart switch-core, where it is set
  from configuration. A client saved under Connector apps takes over once
  configuration is gone, so remove that too.

Disabling the Box MCP server, or deleting the Integration Credentials, in
the Box Admin Console stops Box itself from accepting sign-ins and calls,
but Switch still lists Box as available and may hand out a credential it
already holds, which Box then refuses. Use one of the above to stop Switch
too.

## Limits worth knowing

- Box documents hour-long access tokens but issues longer ones (up to about
  68 minutes measured). Each refresh replaces the refresh credential, and a
  sign-in unused for 60 days lapses at Box; Switch finds out on the next
  use, and from then on the connection shows as needing reconnection under
  Connectors.
- A granted agent's credential is its owner's own, shared by every agent
  they grant; it cannot be narrowed or revoked per agent. Turning Box off
  for an agent takes Box out of its running sessions within about a minute,
  but a credential the agent already holds stays valid at Box until it
  expires. Disconnecting revokes the sign-in at Box and stops every agent
  at once.
- A connection reaches everything its owner can reach in Box, not one
  folder. To keep an agent to some folders, connect a Box user who is a
  collaborator on those folders alone.
- Box applies its own policies (Shield, classification) on top, so a file a
  person can open may still refuse a download or a preview to an agent.
