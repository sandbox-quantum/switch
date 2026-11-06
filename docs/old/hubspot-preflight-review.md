# Private preflight review

HubSpot's measured setup refusal is HTTP 400 with error `invalid_request`
and status `BAD_AUTH_CODE`, including when the secret is deliberately wrong.
This response cannot verify the client. The catalog entry opts into that exact
response shape; other entries retain their existing behavior.

Check and save may store this inconclusive configuration with an unverified
label. It does not create a connection, make the failed check successful, or
prove the redirect URL or credentials. The operator must still meet the
catalog's unchecked redirect requirements. Definite client/redirect errors
remain failures, and the ordinary replacement confirmation still applies.

Only a successful normal sign-in, including identity and token checks and
broker connection, marks an unchanged saved client verified. The update is
conditional on client ID and update time. The regression tests cover unchanged clients and replacement races for both
server-saved and organization-selected clients, including the correct cache
refresh/announcement path. These use a synthetic vendor and a selected
organization adapter, not real vendor credentials.

Private validation: 544 bounded Core tests; 228 focused Node tests; 13
Chromium admin tests; Console typecheck and focused mypy/ruff clean. These are
synthetic tests, not an actual vendor sign-in or a native Console launch.
No OAuth demo, refresh measurement or PR submission is claimed.

Maintainer clarification:
https://github.com/sandbox-quantum/switch/issues/830#issuecomment-6678453089
