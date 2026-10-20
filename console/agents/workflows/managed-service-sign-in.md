# Managed service onboarding

The managed service is Switch Cloud: point a run at it with `SWITCH_CLOUD_URL`,
or bake it into a build with `MAIN_VITE_SWITCH_CLOUD_URL` (see "Switch Cloud" in
`AGENTS.md`). The gateway and agent API share that origin. The value is public
build configuration, not a secret. With neither set the Cloud is not offered,
and an invalid value is reported where the Cloud would be.

Add server → Connect to Switch Cloud reuses server registration, password/SSO
sign-in (or creating an account, where the server allows sign-up) and encrypted
session storage. A matching server entry is reused, and an account already
signed in goes straight on to the connections step, then to a new agent whose
run location is Switch cloud.

## Switch cloud agents

Signing in to Switch Cloud claims and starts the user's cloud machine
(`/gateway/hosted-machines/ensure`). The machine runs the agents controller, so
a Switch cloud agent is a managed agent placed on that machine's controller
once it has enrolled and is online, created like an agent on any other machine.
Provider logins reach the machine sealed to its controller ("Give login"); the
server stores no provider credentials of its own. Your Agents shows the machine
with its state, disk, and start, stop and retry.

Legacy local Claude drafts are never uploaded and are still cleared on sign-out
or server removal.

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
This step does not provision agents.
