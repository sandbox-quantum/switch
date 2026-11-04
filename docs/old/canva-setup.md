# Canva on a self-hosted server

Agents can search, read, create, edit and export their owners' Canva designs
once the server's operator creates a Canva app. Each person then connects their
own Canva account from Switch Console and turns Canva on for the agents they
choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Canva.

Without the app, Canva is listed on the server as not set up.

## Create the app

In [Canva's Developer Portal](https://www.canva.com/developers/apps), create an
app. Use a Canva account your organization owns: whoever owns the app can delete
it, and that stops every connection.

1. Under **Outside Canva**, choose **Start integrating**, then turn on
   **Canva MCP** under Configuration, Integration methods.
2. Under **Redirect URLs**, add all five. Sign-ins come back to Switch Console
   on people's own computers, so the server needs no public address:
   ```
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```
3. Under **Scopes**, tick the scopes the setup dialog lists. `profile:read` is
   among them: a sign-in without it gets an error from Canva's MCP server.
4. Copy the **Client ID**, then generate a secret and copy it. Canva shows the
   secret only once.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Canva**, paste the Client ID and
secret, and choose **Check and save**. Switch asks Canva about the client and
saves it only if Canva accepts the two together. That cannot show the redirect
URLs, the scopes or the Canva MCP switch, so connect once to confirm them.

### Or, from configuration

Write the client id and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with an
absolute path and restart it:

```bash
CANVA_CLIENT_CONFIG_PATH=/etc/switch/canva-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.canvaClientSecret`.

**Configuration wins**: while it is set, a client saved in the dashboard is
ignored. If the file cannot be read or holds anything else, switch-core does not
start, and says why.

## Limits

- A connection can read and write. Canva's approval page has nothing to untick,
  so a person can't connect read-only.
- What an agent can do depends on the person's plan: autofill, brand kits, brand
  templates and resizing need Canva Pro or above.
- Canva limits each person's calls per minute, across every app they use.
- Disconnecting revokes the sign-in at Canva, and the agent's token stops working
  at once.

## Switching it off

Add `canva` to `DISABLED_SERVICES`, remove the client under Connector apps,
unset `CANVA_CLIENT_CONFIG_PATH`, or set the entry's `enabled: false`.
