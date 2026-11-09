# Dropbox on a self-hosted server

Agents can read and update files in their owners' Dropbox accounts once the
server's operator creates a Dropbox app. Each person then connects their
own Dropbox account from Switch Console and turns Dropbox on for the agents
they choose.

The connection covers Dropbox's hosted MCP server at
`https://mcp.dropbox.com/mcp`. Dropbox describes the server as both open
beta and generally available; beta terms apply, so check them before
turning it on for everyone.

## What you need

- A Dropbox account. A free Basic account works for registering an app;
  confirm the hosted MCP server itself works for your plan before rolling
  out (Dropbox's help article names no plan gate, but the server is in
  beta).
- The server's **`GATEWAY_PUBLIC_URL`**, if sign-ins should come back to
  Switch over the server's own address. Without it, only the loopback
  redirect (Switch Console's own listener) is registered.

## Create the Dropbox app

In the [Dropbox App Console](https://www.dropbox.com/developers/apps),
choose **Create app**:

1. **API**: Scoped access.
2. **Access type**: Full Dropbox.
3. **Name** it as people should see it, for example "Switch".

The current connection flow requests the broadest catalog access level.
The default entry below therefore asks for write access. For private
read-only QA, remove the entire `access.write` block before connecting and
enable only read scopes in the app. Do not rely on a Console access picker.

For the default read/write entry, on the app's **Permissions** tab, enable:

- `account_info.read`
- `files.metadata.read`
- `files.content.read`
- `files.content.write`
- `sharing.read`
- `sharing.write`
- `file_requests.read`
- `file_requests.write`

On the app's **Settings** tab, register every one of these **OAuth 2
redirect URIs**, exactly, port included:

```
http://127.0.0.1:39251/switch-services/callback
http://127.0.0.1:39252/switch-services/callback
http://127.0.0.1:39253/switch-services/callback
http://127.0.0.1:39254/switch-services/callback
http://127.0.0.1:39255/switch-services/callback
<GATEWAY_PUBLIC_URL>/gateway/service-connections/dropbox/flows/callback
```

Leave the last one out where the server has no public URL. Dropbox sends
people back only to a registered URI, matched exactly, so if the public URL
changes, change it here too, or sign-ins fail.

## Give the app to Switch

Leave **Allow public clients** enabled. Switch uses PKCE S256 and needs only
the **App key**, not the App secret. Store `{"client_id": "YOUR_APP_KEY"}`
in a client config file, and point `DROPBOX_CLIENT_CONFIG_PATH` at it.
The App secret is not needed for this public-client flow.

Note: Dropbox's "Generate access token" button makes a short-lived token
for trying the API by hand; Switch never uses it, because it cannot be
refreshed. People connect with the normal sign-in instead.

## Disconnecting

Disconnect stops Switch using the sign-in and calls Dropbox's token-revoke
endpoint with the access token as bearer authentication. Dropbox documents that
this also disables the corresponding refresh token and other access tokens in
that refresh-token family. It does not unlink every independent sign-in for
this app/account, so `revocation_ends_grant` stays false. Reconnecting can revoke
the replaced family's tokens without intentionally preserving them.

The shared request path is covered with fake-vendor tests. Real-account
revocation, reconnect and refresh refusal still need live QA; they are not
claimed by the automated checks. If revocation fails, use Dropbox Settings >
Apps to disconnect Switch. That manual action may affect other sign-ins too.

Sources:
- https://opensource.dropbox.com/SwiftyDropbox/api-docs/latest/Classes/AuthRoutes.html
- https://community.dropbox.com/en/discussion/772526/dropbox-api-for-deleting-the-integration-app-connected-via-oauth2-flow

## Verification status

The automated tests use fake vendor responses. They cover catalog loading,
POST identity with a literal JSON null, offline authorization parameters,
secretless public-client settings and revoke request authentication. They
do not establish hosted MCP plan eligibility, a complete least-scope map,
real sign-in, MCP tools, refresh after natural expiry or revocation behavior.
No live demo is included. These remain manual validation items.

## Sources

- https://help.dropbox.com/integrations/connect-dropbox-mcp-server
- https://docs.dropboxapi.com/dropbox-api/docs/oauth
- https://docs.dropboxapi.com/dropbox-api/docs/get-started/tutorial/app-console
