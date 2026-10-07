# Managed service onboarding

The managed service is Switch Cloud: point a run at it with `SWITCH_CLOUD_URL`,
or bake it into a build with `MAIN_VITE_SWITCH_CLOUD_URL` (see "Switch Cloud" in
`AGENTS.md`). The gateway and agent API share that origin. The value is public
build configuration, not a secret. With neither set the Cloud is not offered,
and an invalid value is reported where the Cloud would be. The Cloud is also
off unless `SWITCH_CLOUD_ENABLED` (or `MAIN_VITE_SWITCH_CLOUD_ENABLED` in a
build) is `true`.

Add server → Connect to Switch Cloud reuses server registration, password/SSO
sign-in (or creating an account, where the server allows sign-up) and encrypted
session storage. A matching server entry is reused, and an account already
signed in goes straight on to the provider selector. The provider selector shows
the registered providers; Claude Code is the only enabled provider in this
increment.

## Claude Code connection

The screen offers an API key or subscription setup token with official setup
instructions. Verify and connect sends the credential over the authenticated
HTTPS gateway connection. The server runs a fixed, tool-free Claude Code request
before storing the credential encrypted for the current tenant and user.
Verification consumes a small amount of API credit or subscription allowance.

The status endpoint returns only the credential kind and last successful check
time. The UI can reopen a connection, replace it, or remove it. Failed verification
does not overwrite an existing connection. Removal deletes the server-side
credential; it does not revoke it at Anthropic. Signing out does not remove a
cloud connection. Legacy local drafts are never uploaded automatically and are
still cleared on sign-out or server removal.

See `deploy/hosted/README.md` for the backend verifier image. A backend without
verification enabled returns a visible unavailable error. GitHub connection,
worker credential delivery and cloud agent creation are separate steps; connecting
Claude does not provision a worker or start a room agent.

## GitHub connection

The GitHub step opens authorization in the system browser. The user then confirms
the GitHub account in Console. Only that authenticated confirmation saves the
credentials. The browser callback uses a short-lived flow, a secure browser cookie
and PKCE; pending attempts expire after ten minutes or a backend restart.

Credentials are encrypted per tenant and user. Expiring user access tokens are
refreshed by the backend. Repository access is fetched from GitHub using the
user token, so the list is limited to repositories both the user and app can
access. Choose repositories opens GitHub App installation; Console checks every five seconds and when it regains focus
until access changes. Checks stop after ten minutes or when the step closes. Disconnect removes Switch's stored credentials and pending
attempts; it does not uninstall the app or revoke GitHub authorization.

The backend requires `HOSTED_GITHUB_CONFIG_PATH`, pointing to a private JSON file
with `client_id`, `client_secret`, `slug`, and `origin` (the HTTPS Switch origin).
The Helm chart can mount it from an existing Secret using
`switchCore.githubConnectionsSecret`; its key must be `github.json`. The callback
URL is `<origin>/gateway/provider-connections/github/callback`. Keep expiring user
tokens enabled in the GitHub App. No app secret belongs in Console build settings.

The handoff store is bounded and process-local, matching the singleton backend.
This step does not issue worker installation tokens or provision agents. The app
signing key and worker credential renewal belong to cloud-agent setup.
