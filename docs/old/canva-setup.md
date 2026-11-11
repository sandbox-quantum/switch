# Canva on a self-hosted server

Agents can search, read, create, export and change their owners' Canva designs
once the server's operator registers a Canva integration. Each person then
connects their own Canva account from Switch Console and turns Canva on for the
agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Adding a connector.

Without the integration, Canva is listed on the server as not set up.

## What you need

- A **Canva account** to own the integration. Use one that belongs to the
  organization rather than to one person: whoever owns the integration can
  edit or delete it, and deleting it stops every connection on the server.
- **Access to Canva's MCP server** for that integration. It is a setting on
  the integration in Canva's Developer Portal, and Canva may need to approve
  the integration before people outside its owner can authorize it. Switch
  cannot see either, so a passing check does not prove the tools will work.
- A **Canva plan** that includes the tools people need. Canva refuses some
  tools on lower plans, though its server still lists them.

No `GATEWAY_PUBLIC_URL` is needed: sign-ins come back to Switch Console's own
listener on the person's computer.

## Register the integration

In Canva's Developer Portal, at [canva.dev](https://www.canva.dev), create an
integration:

1. **Name** it as people should see it on Canva's consent page, for example
   "Switch".
2. **Redirect URLs**: all five of these, exactly. Canva matches the port too.
   ```
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```
3. **Scopes**:
   - Read: `design:meta:read`, `design:content:read`
   - Write: `design:meta:read`, `design:content:read`,
     `design:content:write`
4. **Generate a client secret**.
5. **Enable MCP access** for the integration, and publish or seek approval for
   it as Canva requires.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Canva**, copy the five redirect
URLs and the scopes above, and paste the integration's **Client ID** and
**Client secret**. Switch asks Canva about the client and saves it only if
Canva accepts the two together. Asking cannot show whether MCP access is
enabled or whether the integration is approved, so have someone connect
once and use a tool to confirm. The secret is stored encrypted, like every other
stored credential (see [key rotation](key-rotation.md)), and is in use at
once: nobody needs to restart anything.

The card then offers **Check it works**, **Update secret**, **Use a different
app** and **Remove**, as for Google Workspace (see
[google-workspace-setup.md](google-workspace-setup.md)).

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the integration's client id and secret to a JSON file on the server,
readable by switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
CANVA_CLIENT_CONFIG_PATH=/etc/switch/canva-client.json
```

If you deploy with the Helm chart, put the file in a Secret, mount it into the
switch-core pod, and set `CANVA_CLIENT_CONFIG_PATH` to where it is mounted.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why. To move a configured client into the
dashboard, choose **Manage it here instead** on its card, then remove the
variable and restart switch-core; it is the same client, so nobody reconnects.

## What people do

1. In Switch Console: Settings, Connections, Canva, Connect. The browser opens
   Canva's consent page and comes back to Switch Console.
2. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns Canva on. The agent acts as its owner: designs it creates or changes
   show in Canva as done by them.
3. What the agent can do is limited by the scopes above, by the person's own
   access to each design or folder, and by the plan. When a tool is refused,
   the agent is told to report it rather than look for another way in.

Disconnecting revokes the sign-in at Canva. Canva ends the whole lineage of
that refresh token and the person's consent for the integration, so any other
sign-in they still had through it stops too; they connect again if needed.
For the same reason, reconnecting does not revoke the sign-in it replaces.

## Switching it off

Any of these lists Canva as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"canva": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `CANVA_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last four hours. Refresh tokens are single-use: each refresh
  returns a new one and spends the old.
- A connection is named by Canva's opaque user id, not an email or display
  name, because the identity call returns only ids.
- The identity call is rate-limited to 10 requests a minute per user.
- Canva's MCP server must be enabled for the integration in the Developer
  Portal. Switch cannot check this, so a listed tool may refuse.
- Five fixed loopback ports are registered. If all five are busy on the
  person's computer, connecting fails and they can close what holds them and
  try again.
