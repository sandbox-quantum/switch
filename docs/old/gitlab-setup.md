# GitLab on a self-hosted server

Agents can read and update their owners' GitLab projects, issues and other
work items, merge requests, repository files and pipelines once the server's
operator registers a GitLab application. Each person then connects their own
gitlab.com account from Switch Console and turns GitLab on for the agents
they choose. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under GitLab.

Without the application, GitLab is listed on the server as not set up.

This connects **gitlab.com**. A self-managed GitLab instance has its own host,
which this entry cannot vary; see [Self-managed GitLab](#self-managed-gitlab).

## What you need

- A **gitlab.com account** to own the application, or better a **top-level
  group** the organization owns: whoever owns the application can delete it
  or renew its secret, and either stops every connection on the server. A
  group-owned application needs the Owner role in that group.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  GitLab sends people back to Switch there, as Airtable and Google Workspace
  do; without it, GitLab cannot be set up.

GitLab offers dynamic client registration for its MCP server, but an
application registered that way gets only the `mcp` scope and no refresh
token, whatever the registration asks for. Such a sign-in cannot name the
account it belongs to and dies with its two-hour token, so Switch does not
use it.

## Register the application

In GitLab, for a group-owned application open the group, then **Settings**,
**Applications**; for a user-owned one open your avatar, **Edit profile**,
**Access**, **Applications**, then **Add new application**:

1. **Name** it as people should see it on GitLab's authorization page, for
   example "Switch".
2. **Redirect URI**: the server's callback, exactly:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/gitlab/flows/callback
   ```
   If the public URL changes, change it here too, or sign-ins fail.
3. Keep **Confidential** ticked. Switch keeps the secret on the server and
   sends it with every token request.
4. **Scopes**: exactly these three.
   - `mcp`, which GitLab's MCP server requires
   - `read_api`, what a read-only sign-in would ask for
   - `api`, what a read-and-write sign-in asks for

   Leave out `sudo`, `admin_mode`, the runner, registry and observability
   scopes, `ai_features` and the OpenID scopes: Switch never asks for them,
   and GitLab refuses a sign-in that asks for a scope the application lacks.
5. **Save application**. GitLab shows the **Application ID** and the
   **Secret**; copy both.

## Give Switch the client

In Switch Console, open **Admin** in the sidebar and **Connector apps** under
Server, or in the Switch dashboard open **Connectors** beside Users. Both are
shown to the server's operator only, and only with the server's
`service_connections` flag on. Choose **Set up GitLab**. The dialog walks the
steps above, with the redirect URI to copy and the scopes to tick; paste the
**Application ID** as the client ID and the **Secret** as the client secret,
and choose **Check and save**. Switch first asks GitLab about the client, and
saves it only if GitLab accepts the ID and secret together. That cannot show
the redirect URI, which GitLab compares only when someone signs in, so
connect once yourself to confirm it. The secret is stored encrypted, like
every other stored credential (see [key rotation](key-rotation.md)), and is
in use at once: nobody needs to restart anything.

The card then offers **Check it works**, **Update secret**, **Use a different
app** and **Remove**, as for Airtable (see
[airtable-setup.md](airtable-setup.md)). Renewing the secret in GitLab
("Renew secret") stops every sign-in and refresh until the new one is saved
here under **Update secret**.

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
switch-core does not start, and says why. To move a configured client into the
dashboard, choose **Manage it here instead** on its card, then remove the
variable and restart switch-core; it is the same client, so nobody reconnects.

## Allow the MCP server for the group

On gitlab.com, GitLab's MCP server answers a person only if a top-level group
they belong to allows access to it, under the group's **Settings**,
**General**, **Permissions and group features**, **Allow access to the MCP
server**. It is on unless an Owner turned it off (GitLab turned it on for
existing groups in 19.6). Where it is off for every group a person belongs
to, their sign-in completes but every call after it is refused with 403, and
the agent says so.

## What people do

1. In Switch Console: Settings, Connections, GitLab, Connect. The browser
   opens GitLab's authorization page and comes back to Switch Console.
2. GitLab's page lists what Switch asks for and offers Authorize or Deny;
   nothing can be left out. So every connection can write, and what an agent
   reaches is bounded by the person's own role in each project and group:
   where they are a Guest or Reporter, GitLab refuses the agent's writes.
3. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns GitLab on. The agent acts as its owner: issues, comments, merge
   requests, commits and pipeline actions it makes show in GitLab as done by
   them.

Disconnecting revokes the sign-in at GitLab, so it stops working there too.
A person can also revoke it themselves under **Edit profile**, **Access**,
**Applications**, **Authorized applications**.

## Switching it off

Any of these lists GitLab as unavailable, with its reason, and stops agents'
next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"gitlab": "Paused while we review access."}'`;
- remove its client under Connector apps;
- unset `GITLAB_CLIENT_CONFIG_PATH`, where it is set from configuration.

## Limits worth knowing

- Access tokens last two hours, and Switch renews them before they lapse. A
  renewal ends the previous token at once, so a session holding it is
  refused once and asks again.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off
  stops its sessions within a minute; disconnecting stops every agent at
  once and revokes the sign-in at GitLab.
- gitlab.com limits MCP calls per person, not per client: 60 a minute and
  3,600 an hour on the Free plan, 600 and 5,000 on Premium and Ultimate,
  shared with every other MCP client the person uses. The skill tells agents
  to prefer searches and filtered lists, and to wait as long as a 429 says.
- GitLab lists its Duo tools (starting and steering GitLab Duo sessions) only
  where the person's group has GitLab Duo, and the security and wiki tools
  not at all through this connection. A Duo session spends the organization's
  GitLab Duo allowance; the skill tells agents to start one only when asked.

## Self-managed GitLab

This entry names gitlab.com in the MCP server's address, the OAuth endpoints
discovered from it and the identity call, so it cannot connect a
self-managed or Dedicated instance. One would need:

- a catalog entry, or a server setting, carrying the instance's host in all
  three places, since the catalog cannot vary a host per install today;
- GitLab 18.6 or later, with the MCP server allowed for the instance by an
  administrator under **Admin**, **Settings**, **General**, **Visibility and
  access controls**, **Allow access to the MCP server**;
- an application the administrator registers, under **Admin**,
  **Applications**, with the same redirect URI and scopes as above. An
  instance-wide application may be marked trusted, which skips the
  authorization page; and an instance that turned dynamic registration off
  changes nothing for Switch, which never uses it.

## An organization's own GitLab application

With the `organization_connector_apps` flag on (with `service_connections`),
an organization's admins can save its own under **Organization**,
**Connectors** in the dashboard, with the same callback, checks and
encryption as above. Every workspace in that organization then signs in
through the organization's application instead of the server's; the others
keep using the server's. If the organization's application stops working, its
workspaces see GitLab as unavailable, with the reason, rather than falling
back to the server's. Removing it sends them back to the server's
application, and people connected through it reconnect once. The flag is off
by default.
