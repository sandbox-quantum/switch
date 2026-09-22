# Managed service onboarding

Set `VITE_SWITCH_MANAGED_URL` to the HTTPS origin of the managed service when
starting or building Console. The gateway and agent API must share that origin.
The value is public build configuration, not a secret. A missing or invalid
value produces a visible error before the sign-in form opens.

Add server → Switch-managed reuses server registration, password/SSO sign-in,
and encrypted session storage. A matching server entry and valid session are
reused. The provider selector shows the registered providers; Claude Code is the
only enabled provider in this increment.

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

## GitHub preview

The connected Claude screen continues to a GitHub App introduction. It explains
repository selection, intended contents and pull request access, and revocation.
Back reloads the Claude connection; Set up later ends onboarding. The connection
button is disabled with an explicit preview notice. No authorization flow or
GitHub credential storage is implemented in this increment.
