# Asana on a self-hosted server

Agents can read and update tasks and projects as their owners once the server's
operator registers an Asana MCP app. Each person connects their own Asana account
in Switch Console, chooses a workspace, and turns Asana on for the agents they
choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Asana.

Without the app, Asana is listed on the server as not set up.

## What you need

- An **Asana account** to own the app. Use one the organization owns: whoever
  owns the app can delete it, which stops every connection through it.
- Access to each Asana workspace whose people should be allowed to connect, so
  you can include it under **Manage distribution**. Asana refuses people in
  workspaces outside the app's distribution.

## Register the app

In [Asana's developer console](https://app.asana.com/0/my-apps):

1. Create a new app and choose **Asana MCP** as its type, not **API app** or
   **External MCP**. Use the organization-owned account above.
2. Name it as people should see it on Asana's consent page, for example
   "Switch".
3. On its **OAuth** tab, add every redirect URL below. Asana matches the port
   exactly, and Switch Console listens on the first free one:

   ```text
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```

4. Under **Manage distribution**, choose **Specific workspaces** and include
   each workspace whose people may connect, or choose **Any workspace**. Asana
   refuses everyone else with "This app is not available to your workspace".
5. Copy the **Client ID** and **Client secret** from the OAuth tab. Asana cannot
   confirm them until someone connects, so arrange a first connection after
   saving.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or open **Connectors** in the Switch dashboard. Only the server's
operator sees these pages, and only when `service_connections` is on. Choose
**Set up Asana**, follow the steps above, confirm the app type and distribution,
and enter its Client ID and Client secret. **Check and save** discovers Asana's
OAuth endpoints and saves the client as **unchecked**: Asana does not confirm
the ID, secret, redirect URLs, app type or distribution before a real sign-in.
Have someone in each allowed workspace connect once to confirm them. A saved
client is in use at once, without restarting the server.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it and refuses saving a dashboard client.

Write a JSON file on the server, readable by switch-core alone and never
committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Point switch-core at its absolute
path and restart it:

```bash
ASANA_CLIENT_CONFIG_PATH=/etc/switch-asana/client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.asanaClientSecret`. If the variable is set but the file cannot be
read or has other keys, switch-core refuses to start and says why. To move a
configured client into Connector apps, choose **Manage it here instead**,
remove the variable, and restart switch-core.

## What people do

1. In Switch Console, open **Settings**, **Connections**, **Asana**, then
   **Connect**. Asana's page asks them to authorize the app.
2. Choose the Asana workspace the connection will reach. A sign-in authorizes
   one workspace; every connection can write within the person's own Asana
   permissions.
3. On an agent's page, turn Asana on. The agent acts as its owner when reading
   or changing tasks and projects.

If a person reconnects Asana and chooses a different workspace, Switch removes
that person's existing Asana agent grants. They must turn Asana on again for
each agent that should reach the new workspace.

## Switching it off

To list Asana as unavailable and stop agents' next requests:

- add it to `DISABLED_SERVICES`, for example
  `DISABLED_SERVICES='{"asana": "Paused while we review access."}'`; or
- remove any saved client under Connector apps **and** unset
  `ASANA_CLIENT_CONFIG_PATH` where it is set from configuration. Restart
  switch-core after unsetting it.

Configuration takes precedence, but Switch falls back to a saved client when
the variable is unset. Clear both sources if both were set.

## Limits worth knowing

- Access tokens last an hour. Switch renews them without another sign-in; Asana
  accepts the same refresh token again when renewing.
- Every connection can write. Asana offers no narrower consent for MCP apps;
  what an agent can do is bounded by its owner's Asana permissions and whether
  that owner grants the connection to the agent.
- Disconnecting in Switch revokes at Asana. Revoking one sign-in, including by
  removing Switch on Asana's side, ends every Switch connection that person
  made through this app, including one in another Switch workspace on the same
  server.
- After removal on Asana's side, agents see "Not Authorized" until the owner
  reconnects Asana in Switch Console.

## Troubleshooting

- **"This app is not available to your workspace"**: add that workspace under
  Manage distribution or choose Any workspace.
- **"redirect_uri … does not match"**: add the missing loopback port's exact
  callback URL on the app's OAuth tab.
- **"could not identify the account through MCP"**: check that the app's type
  is Asana MCP, not API app, and that its Client secret is correct.
