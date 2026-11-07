# BigQuery on a self-hosted server

Agents can list their owners' BigQuery datasets and tables and run SQL on them
once the server's operator registers a Google app with a Web client. Each person
then connects their own Google account from Switch Console and turns BigQuery on
for the agents they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under BigQuery.

Without the client, BigQuery is listed on the server as not set up.

## What you need

- A **Google Cloud project** to own the app. The BigQuery API is on in a new
  project. Billing is optional: without it, BigQuery runs in its sandbox.
- Nothing on the server itself: sign-ins come back to Switch Console on the
  person's computer, so the server needs no public address.

## Register the app

In Google Cloud:

1. [Create a project](https://console.cloud.google.com/projectcreate), or pick
   one.
2. In [Google Auth Platform](https://console.cloud.google.com/auth/branding),
   under **Branding**, enter an app name people will recognise and a support
   email. Under **Audience**, choose **Internal** for your organization's
   accounts only, or **External**. An External app in **Testing** lets in only
   the test users you add, and Google ends their refresh tokens after 7 days, so
   people reconnect weekly; publish it to lift both.
3. Under **Clients**, create a client of type **Web application**, and under
   **Authorized redirect URIs** add each of these:
   ```
   http://127.0.0.1:39231/switch-services/callback
   http://127.0.0.1:39232/switch-services/callback
   http://127.0.0.1:39233/switch-services/callback
   http://127.0.0.1:39234/switch-services/callback
   http://127.0.0.1:39235/switch-services/callback
   ```
   Switch Console takes the sign-in back on the first of these ports that is
   free. Create the client and copy its **Client ID** and **Client secret**.
4. Give each person who connects these roles on the project (more where agents
   should change data): **BigQuery MCP Tool User** (`roles/mcp.toolUser`),
   **BigQuery Job User** (`roles/bigquery.jobUser`) and **BigQuery Data Viewer**
   (`roles/bigquery.dataViewer`). A project owner has them already.

The same Web client can serve Google Workspace too, if you add its redirect URIs;
the two are saved separately, so their consent screens stay apart.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up BigQuery**. The dialog walks the
steps above; paste the **Client ID** and **Client secret**, and choose **Check
and save**. Switch first asks Google about the client, and saves it only if
Google accepts the two together. That cannot show the redirect URIs or who may
sign in, so connect once to confirm. The secret is stored encrypted, like every
other stored credential (see [key rotation](key-rotation.md)), and is in use at
once: nobody needs to restart anything.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write it to a JSON file on the server, readable by switch-core alone and never
committed anywhere:

```json
{"client_id": "<client id>", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with an
absolute path and restart it:

```bash
BIGQUERY_CLIENT_CONFIG_PATH=/etc/switch/bigquery-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.bigqueryClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, BigQuery, Connect. The browser opens
   Google's consent page and comes back to Switch Console. The person ticks
   **View and manage your data in BigQuery**: Google lets them leave it unticked,
   and Switch then refuses the sign-in.
2. On an agent's page, the agent's owner turns BigQuery on. The agent acts as its
   owner: its queries run, and are billed, as them, and it reaches what their IAM
   roles allow.
3. Disconnecting revokes the sign-in at Google, which ends every sign-in of that
   account to the client, and every agent loses BigQuery at once.

## Switching it off

Any of these lists BigQuery as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"bigquery": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `BIGQUERY_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- A connection reads and writes: BigQuery has one scope, and `execute_sql` runs
  any SQL. The person's IAM roles are what narrow it; with Data Viewer and Job
  User alone, Google refuses changes.
- Every query is billed to the project as the person, at least 10 MB each.
  Results stop at 3,000 rows, and a query is cancelled after three minutes.
- Access tokens last an hour, and Switch renews them on its own. A granted
  agent's token is its owner's own; turning an agent off stops its sessions using
  BigQuery within a minute, and a token already handed out stays valid at Google
  until it expires, up to an hour, or until the owner disconnects.
