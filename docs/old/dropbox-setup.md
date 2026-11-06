# Dropbox on a self-hosted server

Agents can find, read and (where a person allows it) organize files in their
owners' Dropbox accounts once the server's operator registers a Dropbox app.
Each person then connects their own Dropbox account from Switch Console and
turns Dropbox on for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Dropbox.

Without the app, Dropbox is listed on the server as not set up.

## What you need

- A **Dropbox account** to own the app. Use one that belongs to the
  organization rather than to one person: the app belongs to whoever creates
  it, and deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Dropbox sends people back to Switch there, as Google Workspace and Airtable
  do; without it, Dropbox cannot be set up.

## Register the app

In Dropbox, open the **App Console** (https://www.dropbox.com/developers/apps)
and **Create app**:

1. **Scoped access**, then the **Full Dropbox** access type.
2. **Permissions** tab: tick exactly these, then submit.
   - `account_info.read`
   - `files.metadata.read`
   - `files.content.read`
   - `files.content.write`

   Leave out `sharing.read`, `sharing.write`, `file_requests.read` and
   `file_requests.write`: Switch does not ask for them, so Dropbox refuses
   agents' attempts to list or create shared links and file requests.
   Changing an app's permissions later does not change a sign-in already
   made: people reconnect to get a new permission.
3. **Settings** tab, **Redirect URIs**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/dropbox/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
4. Copy the **App key** (the client ID) and the **App secret** (the client
   secret).
5. **Enable additional users** (Settings tab). A new app is in *development*
   and only its owner can connect until this is switched on. Whether Dropbox
   limits the number of people a development app may serve, or requires
   applying for production, is Dropbox's to say; check its App Console.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Dropbox**; the dialog walks the
steps above, with the redirect URL to copy and the permissions to tick. Paste
the **App key** and **App secret** and choose **Check and save**. Switch first
asks Dropbox about the client, and saves it only if Dropbox accepts the key
and secret together. That cannot show the redirect URL, the app's permissions,
or that people other than its owner may connect, so have someone other than
the owner connect once to confirm. The secret is stored encrypted like every
other stored credential (see [key rotation](key-rotation.md)), and is in use at
once.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
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

1. In Switch Console: Settings, Connections, Dropbox. The person chooses
   **Read only** or **Read and write**, then Connect. Nothing is chosen for
   them, and Connect stays off until they pick. The browser opens Dropbox's
   consent page, which lists only the permissions of that choice, and comes
   back to Switch Console.
2. On an agent's page, the agent's owner turns Dropbox on or off. The grant
   has no level of its own: the agent holds the owner's sign-in, so it can do
   what that sign-in was given and no more. The agent acts as its owner:
   anything it creates, moves or deletes shows in Dropbox as done by them.

To change the choice, disconnect and connect again. Switch Console shows the
choice made next to the connection. Connecting again revokes the earlier
sign-in at Dropbox once the new one is saved (below).

A sign-in made for reading holds only the three read permissions. Dropbox
enforces permissions, not Switch and not the Dropbox MCP server: the server
lists the same tools to every connection, including ones that write, and
Dropbox refuses a call whose permission the sign-in lacks.

When someone disconnects, or connects again, Switch revokes the sign-in it
stops using at Dropbox, after the change is saved. Revoking ends that sign-in's
refresh token and every access token made from it, so an agent holding one
stops working at once rather than at its expiry; the person's other Dropbox
sign-ins are not affected. If Dropbox cannot be reached, or refuses, the
connection still changes and Switch says the old sign-in could not be revoked;
the person then removes Switch in Dropbox, under Settings, Security,
Connected apps. An agent host may keep offering a token it fetched earlier for
up to an hour, and Dropbox will refuse it.

## Searching inside files

Dropbox searches the text inside files only on some plans. Its documentation
lists the paid plans (Professional, Essentials, Standard, Business, Advanced,
Business Plus, Enterprise) and does not list Basic, the free plan. Switch tried
it on a free account: searching for a file's name found it, and searches for
words that appear only in files' contents found nothing. Whether a paid plan
searches contents through the Dropbox MCP server has not been tried, so Switch
promises no more than name search; the Dropbox skill tells agents an empty
content search is inconclusive. File *contents* can always be read, whatever
the plan.

## Switching it off

Any of these lists Dropbox as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"dropbox": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `DROPBOX_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last four hours. Dropbox gives one long-lived refresh token,
  which a refresh keeps.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off stops
  its sessions within the token's lifetime; disconnecting stops every agent's
  next request.
- The Dropbox MCP server is in beta, and reads and writes files up to 5 MB a
  call, by Dropbox's documentation.
- Dropbox Sign and Paper tools, where the server offers them, were not tried,
  and this connection asks for no permission made for them.
