# Dropbox on a self-hosted server

Agents can search, browse and read the files and folders in their owners'
Dropbox once the server's operator registers a Dropbox app. Each person then
connects their own Dropbox account from Switch Console and turns Dropbox on
for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Dropbox.

Without the app, Dropbox is listed on the server as not set up.

## What you need

- A **Dropbox account** to own the app. Use one that belongs to the
  organization rather than to one person: whoever owns the app can change or
  delete it, and deleting it stops every connection on the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Dropbox sends people back to Switch there, as Google Workspace and Airtable
  do; without it, Dropbox cannot be set up.
- A **Dropbox plan** that allows the app. The Dropbox MCP server is in open
  beta, and Dropbox's app console may be closed to members by a team admin.

## Register the app

In the [Dropbox App Console](https://www.dropbox.com/developers/apps/),
choose **Create app**:

1. **Choose an API**: Scoped access.
2. **Choose the type of access you need**: Full Dropbox. The MCP server
   searches and reads the person's whole Dropbox, so an App folder is too
   small.
3. **Name your app**: as people should see it on Dropbox's consent page, for
   example "Switch".
4. On the app's **Permissions** tab, tick exactly these three, then
   **Submit**:
   - `account_info.read`
   - `files.metadata.read`
   - `files.content.read`

   Leave the write, sharing and file-request scopes off. Switch asks for the
   three above and nothing else, so agents can read but cannot change, share
   or delete anything. Dropbox refuses a sign-in that asks for a scope the
   app does not have.
5. On the **Settings** tab, under **OAuth 2**, add the redirect URI, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/dropbox/flows/callback
   ```
   Dropbox matches it exactly and takes an `http` one only on `localhost`, so
   it has to be this https callback. If the public URL changes, change it here
   too, or sign-ins fail.
6. Copy the **App key** and the **App secret**.

A new app is in **Development** status and can be linked only to its owner's
account. To let other people connect, open the app's **Info** page and choose
**Enable additional users**: a development app links up to 500 accounts.
Once 50 accounts are linked, Dropbox gives two weeks to apply for production
status; before then the app is frozen for new accounts. Many internal
deployments stay in development.

## Give Switch the app

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Dropbox**, paste the **App
key** as the client id and the **App secret**, and choose **Check and save**.

Switch sends Dropbox a made-up authorization code with the app key and
secret, as a sign-in will, and saves the app only if Dropbox refuses the code
rather than the client. That cannot show the redirect URI or the app's
permissions, so connect once yourself to confirm both. The secret is stored
encrypted, like every other stored credential (see
[key rotation](key-rotation.md)), and is in use at once: nobody needs to
restart anything.

### Or, from configuration

The app can be set in the server's configuration instead. **Configuration
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

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why. To move a configured client into
the dashboard, choose **Manage it here instead** on its card, then remove the
variable and restart switch-core; it is the same client, so nobody reconnects.

## What people do

1. In Switch Console: Settings, Connections, Dropbox, Connect. The browser
   opens Dropbox's consent page and comes back to Switch Console.
2. On Dropbox's page the person signs in and approves the three permissions.
   They see which app is asking, by the name the app was given.
3. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns Dropbox on. The agent acts as its owner and sees what they can see in
   Dropbox, with their own sharing and team permissions.

Dropbox returns an access token that lives four hours and a refresh token,
which Switch uses to renew it without asking the person anything. Changing
the app's permissions means everyone reconnects; Dropbox asks the person to
approve the new set.

Switch cannot revoke the sign-in at Dropbox: the endpoint Dropbox advertises
wants the token in an `Authorization` header, and refuses the request a
standard revocation makes. So when someone disconnects, or reconnects, or a
switched-off workspace stops the connection, Switch says the sign-in still
works, and the person ends it in Dropbox: Settings, **Apps**, in their account
menu at [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps).

## Switching it off

Any of these lists Dropbox as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"dropbox": "Paused while we review access."}'`;
- remove its app under Connector apps;
- unset `DROPBOX_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Agents can read, not write. The connection asks for three read scopes, so
  Dropbox refuses the server's creating, moving, copying, deleting, sharing,
  file-request, Sign and Paper-editing tools. Reading Paper docs is offered
  only where the client supports the server's Paper tools.
- Text extraction stops at 5 MB, and unsupported or oversized files come back
  as Dropbox links instead: the agent is told to say so rather than claim it
  read the file.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off
  stops its sessions within an hour; disconnecting stops every agent at once.
- A development-status app links at most 500 accounts, and freezes new ones
  two weeks after reaching 50 unless it is approved for production.
