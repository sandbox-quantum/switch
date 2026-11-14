# Box on a self-hosted server

Agents can search and read their owners' Box files and folders, and upload and
add to them, once a Box admin issues Integration Credentials and the server's
operator saves them. Each person then connects their own Box account from Switch
Console and turns Box on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Box.

Without the credentials, Box is listed on the server as not set up.

## What you need

- A **Box admin** for the enterprise. A free Box developer account has an Admin
  Console and is enough to try it. Use an account that belongs to the
  organization rather than to one person: whoever owns the credentials can delete
  them, and that stops every connection on the server.
- Nothing on the server itself: sign-ins come back to Switch Console on the
  person's computer, so the server needs no public address.

The credentials belong to one Box enterprise, so a server's people connect
accounts in that enterprise.

## Add the credentials

In the [Box Admin Console](https://app.box.com/master), open **Integrations**:

1. Search for **Box MCP server**, and enable it if it is off.
2. Hover over it and choose **Configure**.
3. Under **Additional Configuration**, choose **+ Add Integration Credentials**,
   name them, **Save**, and open the new entry.
4. Under **Redirect URI**, add each of these:
   ```
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```
   Switch Console takes the sign-in back on the first of these ports that is free.
5. Under **Access Scopes**, tick `root_readwrite`. Leave the AI and Doc Gen scopes
   unticked: Switch does not ask for them, and Box refuses a scope the credentials
   do not have (`invalid_scope`).
6. Save, and copy the **Client ID** and **Client Secret**.

## Give Switch the credentials

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Box**. The dialog walks the steps
above; paste the **Client ID** and **Client secret**, and choose **Check and
save**. Switch first asks Box about them, and saves them only if Box accepts the
two together. That cannot show the redirect URIs, the Access Scopes, or that the
server is enabled for everyone, so connect once to confirm. The secret is stored
encrypted, like every other stored credential (see
[key rotation](key-rotation.md)), and is in use at once: nobody needs to restart
anything.

### Or, from configuration

The credentials can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, credentials saved in the dashboard are
ignored, and saving from the dashboard is refused.

Write them to a JSON file on the server, readable by switch-core alone and never
committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with an
absolute path and restart it:

```bash
BOX_CLIENT_CONFIG_PATH=/etc/switch/box-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.boxClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, Box, Connect. The browser opens Box's
   consent page and comes back to Switch Console. Switch asks for `root_readwrite`,
   so the connection reads and writes.
2. On an agent's page, the agent's owner turns Box on. The agent acts as its owner:
   what it uploads or creates shows in Box as done by them, and it reaches only
   what they can reach.
3. Disconnecting revokes the sign-in at Box, and every agent loses Box at once.

## Switching it off

Any of these lists Box as unavailable, with its reason, and stops agents' next
token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"box": "Paused while we review access."}'`;
- remove its credentials under Connector apps;
- unset `BOX_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens live a little over an hour, and Switch renews them on its own.
- A granted agent's token is its owner's own, shared by every agent they grant; it
  cannot be narrowed or revoked per agent. Turning an agent off stops its sessions
  using Box within a minute; a token already handed out stays valid at Box until it
  expires, up to about 70 minutes, or until the owner disconnects.
- Box AI and Doc Gen are not part of the connection. Box AI's tools are listed, and
  Box refuses them.
- Box's MCP server has no tool that deletes a file or folder.
