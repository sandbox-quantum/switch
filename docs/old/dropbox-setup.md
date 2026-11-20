# Dropbox on a self-hosted server

Agents can search and read their owners' Dropbox files, and with write access
add, move and delete them, once the server's operator registers a Dropbox app.
Each person then connects their own Dropbox account from Switch Console and
turns Dropbox on for the agents they choose. How it
works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Dropbox.

Without the app, Dropbox is listed on the server as not set up.

## What you need

- A **Dropbox account** to own the app. Use one that belongs to the
  organization rather than to one person: whoever owns the app can change or
  delete it, and deleting it stops every connection on the server.
- Nothing on the server itself: sign-ins come back to Switch Console on the
  person's computer, so the server needs no public address.

## Register the app

In Dropbox's [App Console](https://www.dropbox.com/developers/apps/create),
create an app:

1. **Choose an API**: Scoped access.
2. **Choose the type of access**: Full Dropbox.
3. **Name** it as people should see it on Dropbox's consent page.
4. On its **Permissions** tab, tick exactly these four, then **Submit**:
   - `account_info.read`
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`

   Leave the rest unticked. Switch asks for no more than these, and Dropbox
   refuses a scope the app does not have, so a missing one fails every
   sign-in.
5. On its **Settings** tab, under **OAuth 2**, add each of these **Redirect
   URIs**:
   ```
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```
   Switch Console takes the sign-in back on the first of these ports that is
   free, and Dropbox matches the port exactly.
6. On the same tab, copy the **App key** and the **App secret**: they are the
   client ID and client secret below.

A new Dropbox app is in Development status, which limits how many people can
link it. Apply for production on its Settings tab before you offer it widely;
Dropbox's page says how many people a development app takes.

## Give Switch the app

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Dropbox**. The dialog walks the
steps above, with the redirect URIs to copy and the permissions to tick; paste
the **App key** as the client ID and the **App secret** as the client secret,
and choose **Check and save**. Switch first asks Dropbox about the app, and
saves it only if Dropbox accepts the key and secret together. That cannot show
the redirect URIs or the ticked permissions, so connect once at each level to
confirm both. The secret is stored encrypted, like every other stored
credential (see [key rotation](key-rotation.md)), and is in use at once:
nobody needs to restart anything.

### Or, from configuration

The app can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, an app saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the app key and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<app key>", "client_secret": "<app secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
DROPBOX_CLIENT_CONFIG_PATH=/etc/switch/dropbox-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.dropboxClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, Dropbox, Connect. The browser
   opens Dropbox's consent page and comes back to Switch Console. Switch
   asks for the four permissions above, so the connection reads and writes.
2. On an agent's page, the agent's owner turns Dropbox on. The agent acts as
   its owner: files it adds, moves or deletes show in Dropbox as done by them.
3. Disconnecting revokes the sign-in at Dropbox, and every agent loses
   Dropbox at once.

## Switching it off

Any of these lists Dropbox as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"dropbox": "Paused while we review access."}'`;
- remove its app under Connector apps;
- unset `DROPBOX_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last 4 hours, and Switch renews them on its own.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off
  stops its sessions using Dropbox within a minute; a token already handed
  out stays valid at Dropbox until it expires, up to 4 hours, or until the
  owner disconnects.
- Shared links, file requests and team settings are not part of the
  connection. Their tools are listed, and Dropbox refuses them.
- A deleted file goes to Dropbox's deleted files, where it can be restored;
  permanent deletion is not asked for.
- Dropbox's MCP server is in open beta.
