# Airtable on a self-hosted server

Agents can read and update records and comments in their owners' Airtable
bases once the server's operator registers an Airtable OAuth integration. Each
person then connects their own Airtable account from Switch Console, choosing
which bases and workspaces to share, and turns Airtable on for the agents they
choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Airtable.

Without the integration, Airtable is listed on the server as not set up.

## What you need

- An **Airtable account** to own the integration. Use one that belongs to the
  organization rather than to one person: whoever owns the integration can
  edit or delete it, and deleting it stops every connection on the server.
- A **support email, privacy policy URL and terms of service URL** to publish
  with it. Until all three are set, Airtable keeps the integration "limited to
  development use": only its owner can authorize it, and anyone else is
  refused with "This OAuth application cannot be used outside of
  development."

- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Airtable sends people back to Switch there, as Google Workspace does;
  without it, Airtable cannot be set up.

## Register the integration

In Airtable, open **Builder Hub**, then **OAuth integrations**, then
**Register new OAuth integration**:

1. **Name** it as people should see it on Airtable's consent page, for example
   "Switch".
2. **OAuth redirect URL**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/airtable/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
3. **Scopes**: exactly these six.
   - `data.records:read`, `data.records:write`
   - `data.recordComments:read`, `data.recordComments:write`
   - `schema.bases:read`
   - `workspacesAndBases:read`

   Leave out `schema.bases:write`: without it Airtable refuses agents'
   attempts to create or change tables and fields.
4. **Generate a client secret**.
5. **Support information**: fill in the support email, privacy policy URL and
   terms of service URL. Until all three are set, only the integration's
   owner can connect, and nothing Switch asks Airtable shows it.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up Airtable**. The dialog walks
the steps above, with the redirect URL to copy and the scopes to tick;
paste the integration's **Client ID** and **Client secret**, tick that its
support details are set, and choose **Check and save**. Switch first asks
Airtable about the client, and saves it only if Airtable accepts the client ID
and secret together. That cannot show the redirect URL or whether the
integration is published, so have someone other than its owner connect once
to confirm both. The secret is stored encrypted, like every other
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
AIRTABLE_CLIENT_CONFIG_PATH=/etc/switch/airtable-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.airtableClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why. To move a configured client into the
dashboard, choose **Manage it here instead** on its card, then remove the
variable and restart switch-core; it is the same client, so nobody reconnects.

## Airtable Enterprise

An Enterprise admin may restrict third-party integrations to an allowlist, or
block API access to the organization's bases. Give the admin the
integration's client id to allowlist under Admin Panel, Settings,
Integrations & development.

## What people do

1. In Switch Console: Connectors, Airtable, Connect. The browser opens
   Airtable's consent page and comes back to Switch Console.
2. On Airtable's page the person picks everything they can reach, or chosen
   bases, interfaces and workspaces. They cannot leave out the write
   permissions, so every connection can write; what an agent reaches is
   narrowed by the bases shared and by the person's own role in each base.
   They can change the bases later under Integrations in their Airtable
   account menu.
3. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns Airtable on. The agent acts as its owner: records and comments it
   creates, changes or deletes show in Airtable as done by them.

Airtable has no way for Switch to revoke a sign-in, and each sign-in is its
own grant there, listed separately under Integrations, Third-party
integrations, in the person's Airtable account menu. The integration reaches
every base any of those grants shared. So when someone disconnects, or
connects again, the sign-in Switch stops using still works, and its bases
still count toward any Airtable connection they make: one that once shared
everything keeps a later one, sharing a single base, reaching every base.
Switch says so each time, and the person removes the old grant in Airtable.

## Switching it off

Any of these lists Airtable as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"airtable": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `AIRTABLE_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last an hour. A sign-in unused for 60 days lapses, and shows
  as needing reconnection under Connectors.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning Airtable off for
  an agent stops its sessions using it within a minute: the machine running
  them reads the agent's grants again about every 30 seconds. A token already
  handed to it stays valid at Airtable until it expires, at most an hour, and
  disconnecting does not end it sooner, since Switch cannot revoke an Airtable
  sign-in; the disconnect's warning says until when.
- Development bases refuse every call from Airtable's MCP server.
- Reconnecting never narrows what a connection reaches: the bases of every
  grant the person has not removed in Airtable still count (see "What people
  do").
