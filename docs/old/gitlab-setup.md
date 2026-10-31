# GitLab on a self-hosted server

Agents can read and update projects, issues, merge requests and pipelines in
their owners' GitLab accounts once the server's operator registers a GitLab
OAuth application. Each person then connects their own GitLab account from
Switch Console and turns GitLab on for the agents they choose. How it works is
in [`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under GitLab.

Without the application, GitLab is listed on the server as not set up.

## What you need

- A **GitLab account** with permission to register applications (on GitLab.com
  or within an organization group). Use an account or group owned by the
  organization rather than an individual developer: whoever owns the
  application can edit or delete it, and deleting it stops every connection on
  the server.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  GitLab sends people back to Switch there, as Google Workspace and Airtable
  do; without it, GitLab cannot be set up.

## Register the application

In GitLab, navigate to **User Settings** (or your Group Settings), then
**Applications** (`https://gitlab.com/-/user_settings/applications`):

1. **Name**: "Switch" (or the name people should see on GitLab's consent page).
2. **Redirect URI**: the server's callback URL, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/gitlab/flows/callback
   ```
   If the public URL changes, update it here too, or sign-ins fail.
3. **Confidential**: keep checked (the client secret will be stored securely by
   Switch).
4. **Scopes**: select exactly these four scopes:
   - `mcp`: required by GitLab's remote MCP server (`https://gitlab.com/api/v4/mcp`).
   - `read_user`: grants read-only access to user profile information for identity resolution (`/api/v4/user`).
   - `read_api`: grants read-only access to the GitLab API (projects, issues, merge requests, repository files, pipelines).
   - `api`: grants write access to the GitLab API for modifying work items, merge requests, branches, and pipelines.
5. Save the application. GitLab will display the **Application ID** (Client ID)
   and **Secret** (Client Secret). Copy both.

### Why not dynamic registration?

GitLab supports OAuth 2.0 Dynamic Client Registration (RFC 7591), but GitLab.com
limits dynamically registered clients to the `mcp` scope only, without issuing
refresh tokens or user profile scopes. Without a refresh token, sessions
cannot renew access; without `read_user`, user identity cannot be resolved;
and without `read_api` / `api`, fine-grained read-only separation is impossible.
A static OAuth application is therefore required.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Choose
**Set up GitLab**. The dialog displays the redirect URL to copy; ensure you
selected the four scopes listed above when creating the application in GitLab,
then paste the application's **Application ID** as the Client ID and the
**Secret** as the Client Secret, and choose **Check and save**.

Switch verifies the client credentials and stores the secret encrypted (see
[key rotation](key-rotation.md)).

### Or, from configuration

The client can be set in the server's configuration instead. **Configuration
wins**: while it is set, Switch uses it, an app saved in the dashboard is
ignored, and saving from the dashboard is refused.

Write the application's client ID and secret to a JSON file on the server,
readable by switch-core alone and never committed anywhere:

```json
{"client_id": "<Application ID>", "client_secret": "<Secret>"}
```

The file must hold exactly those two keys. Then point switch-core at it with
an absolute path and restart it:

```bash
GITLAB_CLIENT_CONFIG_PATH=/etc/switch/gitlab-client.json
```

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

Connecting requires an account on GitLab.com, and a top-level group owner or
instance admin must allow MCP access for the relevant group.

1. In Switch Console: Settings, Connections, GitLab, Connect. The browser
   opens GitLab's consent page and returns to Core's callback.
2. On an agent's page, the owner turns GitLab on. The agent acts as its owner:
   actions it performs show in GitLab as done by them.

## Switching it off

Any of these lists GitLab as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"gitlab": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `GITLAB_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last 2 hours. Refresh tokens rotate on use.
- An agent's already-issued token may keep working up to 2 hours after access is
  withdrawn.
- `api` is GitLab's only write scope and covers modifying work items, merge
  requests, branches and pipelines, and reaches delete endpoints. The skill
  instructs agents to obtain explicit confirmation before destructive or
  consequential changes.
- Self-managed GitLab instances: currently Switch is configured for
  `gitlab.com`'s OAuth endpoints and remote MCP server. Self-managed instances
  are not supported today.
