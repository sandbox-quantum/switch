# Google Workspace on a self-hosted server

Agents can work in their owners' Google Drive, Docs, Sheets, Slides and
Calendar once the server's operator registers a Google app for the
organization. Each person then connects their own Google account from Switch
Console, and turns Google Workspace on for the agents they choose. Gmail is not
offered. How it works is in
[`docs/design/service-connections-v2.md`](../design/service-connections-v2.md),
under Google Workspace.

Without the app, Google Workspace is listed on the server as "Not set up on
this server. Its operator registers an internal Google app; see the docs."

## What you need

- A **Google Workspace organization**, and an account in it that can create
  Cloud projects. A personal Gmail account cannot make an Internal app.
- The server's **`GATEWAY_PUBLIC_URL`**: the address people reach Switch at.
  Google sends each sign-in back to it. It must be `https://`, or
  `http://localhost:<port>` for a server on your own computer, which Google
  accepts for testing.

No Google preview programme is involved: Switch uses Google's generally
available APIs.

## Register the app

1. **Create a Cloud project** at console.cloud.google.com while signed in to
   the Workspace organization, with the organization as its parent.
2. **Turn on the APIs** under APIs & Services, Library: the Google Drive,
   Google Docs, Google Sheets, Google Slides and Google Calendar APIs. Or:
   ```bash
   gcloud services enable drive.googleapis.com docs.googleapis.com \
     sheets.googleapis.com slides.googleapis.com calendar-json.googleapis.com \
     --project <project id>
   ```
3. **Set up the consent screen** under Google Auth Platform: give the app a
   name people will recognise (it is what Google's consent page shows), and set
   the audience to **Internal**. An Internal app is used only within your
   organization, needs no Google verification, and keeps refresh tokens alive
   beyond the seven days an External app in Testing gets.
4. **Create a client** under Google Auth Platform, Clients: type **Web
   application**, with one authorized redirect URI:
   ```
   <GATEWAY_PUBLIC_URL>/gateway/service-connections/google-workspace/flows/callback
   ```
   for example
   `https://switch.example.com/gateway/service-connections/google-workspace/flows/callback`.
5. **Check the Admin console** does not block it: Security, Access and data
   control, API controls. Depending on your organization's settings, an
   internal app may need to be marked trusted there.

## Give Switch the client

Write the client's id and secret to a JSON file on the server, readable by
switch-core alone and never committed anywhere:

```json
{"client_id": "<client id>.apps.googleusercontent.com", "client_secret": "<client secret>"}
```

The file must hold exactly those two keys. (The JSON Google Cloud lets you
download wraps them in `"web": {...}` with more besides; copy the two values
out.) Then point switch-core at it with an absolute path and restart it:

```bash
GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH=/etc/switch/google-workspace-client.json
```

If the variable is set but the file cannot be read or holds anything else,
switch-core does not start, and says why.

## What people do

1. In Switch Console: Settings, Connections, Google Workspace, Connect. The
   browser opens Google's consent page, then comes back through the server to
   Switch Console, which asks the person to confirm the account.
2. Google lists what Switch asks for: reading and changing Drive files, Docs,
   Sheets, Slides and calendar events, and the account's address. Unticking the
   change permissions connects read-only, and Google then refuses every change
   an agent tries.
3. On an agent's page (in Switch Console or the dashboard), the agent's owner
   turns Google Workspace on. The agent acts as its owner: what it creates or
   changes shows in Google as done by them.

To connect read-only after connecting for read and write, disconnect first:
while Switch holds access, Google's consent page has nothing to untick.
Disconnecting revokes Switch's access at Google.

Sessions run Google's `gws` command-line tool, which Switch downloads on first
use to `~/.local/state/switch/tools/` on the machine running the session (from
GitHub, checked against a pinned SHA-256), so those machines need to reach
`github.com` over HTTPS. There is no build for Windows on Arm; an agents
controller reports the tool's state among its tools.

## Switching it off

Any of these lists Google Workspace as unavailable, with its reason, and stops
agents' next token requests:

- add it to `DISABLED_SERVICES`, e.g.
  `DISABLED_SERVICES='{"google-workspace": "Paused while we review access."}'`;
- unset `GOOGLE_WORKSPACE_CLIENT_CONFIG_PATH`.

Switch's own hosted service does the first in its deployment settings until
its app has passed Google's review.

## Limits worth knowing

- Google keeps at most 100 refresh tokens per account per client, dropping the
  oldest silently, and an admin's session-length policy can end them sooner.
  A lapsed connection shows as needing reconnection under Connections.
- A granted agent's token is its owner's own, shared by every agent they
  grant; it cannot be narrowed or revoked per agent. Turning an agent off stops
  its sessions within an hour; disconnecting stops every agent at once.
