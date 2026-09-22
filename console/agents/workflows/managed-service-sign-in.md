# Managed service sign-in

Set `VITE_SWITCH_MANAGED_URL` to the HTTPS origin of the managed service when
starting or building Console. The gateway and agent API must share that origin.
The value is public build configuration, not a secret. Do not put credentials in it.
A missing or invalid value produces a visible error before the sign-in form opens.

The Add server → Switch-managed path reuses the existing server registration,
password/SSO authentication, and encrypted session storage. It reuses a matching
server entry and checks its session before asking the user to sign in again.

This increment connects an account only. Provider/GitHub connections and worker
provisioning are not implemented by this screen. No sidecar changes are required.

## Claude Code credential draft

The next screen offers an API key or a subscription setup token, with links to
Claude's official setup instructions. It saves one draft per server through the
existing OS-backed encrypted secret store. The renderer never reads a saved
credential back. Switching credential type clears the input; a later save
replaces the previous draft. Signing out or removing the server deletes it.

This draft is local only: there is no hosted credential API, provider validation,
or worker delivery in this increment. The UI states this before and after saving.
No model call is made. The hosted bootstrap already accepts both credential kinds,
but the draft is not yet connected to that bootstrap.
