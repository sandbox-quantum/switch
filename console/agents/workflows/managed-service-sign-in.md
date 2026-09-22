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
