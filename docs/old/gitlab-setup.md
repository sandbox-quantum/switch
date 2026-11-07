# GitLab on a self-hosted server

Agents can work with issues, merge requests and pipelines in their owners'
GitLab.com projects once the server's operator registers a GitLab OAuth
application. Each person then connects their own GitLab account from Switch
Console and turns GitLab on for the agents they choose. Agents use GitLab's
own MCP server (`https://gitlab.com/api/v4/mcp`). How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under GitLab.

Without the application, GitLab is listed on the server as not set up.

## What you need

- A **GitLab.com account or group** to own the application. Use one that
  belongs to the organization rather than to one person: whoever owns the
  application can edit or delete it, and deleting it stops every connection
  on the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  GitLab sends people back to Switch there, as Google Workspace and Airtable
  do; without it, GitLab cannot be set up.

GitLab.com only: a self-managed GitLab instance has its own host, which the
catalog entry does not offer.

## Register the application

In GitLab, open your avatar, **Edit profile**, then **Applications**, or a
group's **Settings**, **Applications**, and choose **Add new application**:

1. **Name** it as people should see it on GitLab's consent page, for example
   "Switch".
2. **Redirect URI**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/gitlab/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
3. **Confidential**: keep it ticked. Switch's server keeps the secret.
4. **Scopes**: exactly these two.
   - `mcp`, for GitLab's MCP server
   - `read_user`, so Switch can tell whose account a sign-in is

   Leave out `api`: it opens the whole REST API, beyond the MCP server's
   tools.
5. **Save application**, and copy its **Application ID** and **Secret**.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up GitLab**. The dialog walks the
steps above, with the redirect URI to copy and the scopes to tick; paste the
application's ID as the **Client ID** and its secret as the **Client secret**,
and choose **Check and save**. Switch first asks GitLab about the client, and
saves it only if GitLab accepts the ID and secret together. That cannot show
the redirect URI or the application's scopes, so have someone connect once to
confirm both. The secret is stored encrypted, like every other stored
credential (see [key rotation](key-rotation.md)), and is in use at once:
nobody needs to restart anything.

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, a client saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the application's ID and secret to a JSON file on the server, readable
by switch-core alone and never committed anywhere:

```json
{"client_id": "<application id>", "client_secret": "<secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
GITLAB_CLIENT_CONFIG_PATH=/etc/switch/gitlab-client.json
```

With the Helm chart, put `client.json` in a Secret and name it in
`switchCore.gitlabClientSecret`.

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. The owner of each top-level group whose projects agents should reach allows
   MCP for it: the group's **Settings**, **General**, **Permissions and group
   features**, then under **MCP client access** tick **Allow connection to
   GitLab**. Until then GitLab refuses those projects.
2. In Switch Console: **Connectors**, then **Connect GitLab**. The browser
   opens GitLab's consent page and comes back to Switch Console. The consent
   page lists both scopes with nothing to untick, so every connection can
   write.
3. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns GitLab on. The agent acts as its owner, within their own project
   permissions: issues, comments and merge requests it creates show in GitLab
   as theirs.

Disconnecting revokes the sign-in at GitLab, and the application leaves the
person's **Authorized applications**.

## Switching it off

Any of these lists GitLab as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"gitlab": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `GITLAB_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last two hours, and each refresh replaces the refresh token.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off stops
  its sessions within two hours; disconnecting stops every agent at once.
- GitLab.com rate-limits each user's API calls, and an agent's calls are its
  owner's.
