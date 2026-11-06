# Monday.com connector: staged OAuth integration

The catalog entry is **disabled**. It is visible as unavailable and cannot be
connected or granted. Its skill is checked at load time but is not supplied to
sessions. Changing `enabled` alone fails catalog validation: token policy and
access levels are deliberately absent until the provider contract is verified.

No Monday credentials were available for this implementation. No authorization,
token exchange, identity call, refresh, revocation or authenticated MCP operation
has been tested against Monday. No room demonstration or video is claimed.

## Provider evidence

Checked on 2026-11-06:

- Switch's `OAuthAdapter.endpoints()` successfully discovered the public
  endpoints below from the staged definition, without registering a client
  or authenticating. This checks discovery only, not the OAuth lifecycle.
- [MCP integration guide](https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp):
  Streamable HTTP at `https://mcp.monday.com/mcp`. The old SSE URL is unsupported.
- [Live protected-resource metadata](https://mcp.monday.com/.well-known/oauth-protected-resource):
  resource `https://mcp.monday.com/mcp`, authorization server
  `https://auth.monday.com/mcp`, bearer authentication in headers.
- [Live authorization-server metadata](https://auth.monday.com/.well-known/oauth-authorization-server/mcp):
  authorization at `https://auth.monday.com/oauth2/authorize`, token exchange at
  `https://auth.monday.com/oauth_ms/oauth/token`, registration at
  `https://auth.monday.com/oauth_ms/oauth/register`, and revocation at
  `https://auth.monday.com/oauth_ms/oauth/revoke`. It advertises authorization
  code and refresh grants, PKCE S256, and token endpoint authentication methods
  `client_secret_post`, `client_secret_basic`, and `none`. It advertises neither
  `scopes_supported` nor a user-info endpoint.
- [Public MCP clients](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration):
  DCR is supported; additional clients require account approval. The discovery
  table in this guide lists older MCP-host endpoints. Use live discovery, as
  Switch does, rather than pinning that table's endpoints.
- [Current-user API](https://developer.monday.com/api-reference/reference/me):
  GraphQL `me` exposes `id` and `email` and documents `me:read` for app scopes.
  The catalog sends the static JSON query `{ me { id email } }` by HTTPS POST
  to `https://api.monday.com/v2`, reading `data.me.id` and `data.me.email`.
  Acceptance of a DCR-issued MCP token at this Platform API endpoint, including
  its bearer header and audience, remains unverified.

## Token and permission blockers

The [legacy OAuth guide](https://developer.monday.com/apps/docs/oauth) describes
non-expiring tokens without refresh.
The [new OAuth migration guide](https://developer.monday.com/apps/docs/migrating-to-the-new-oauth-flow)
describes expiring JWT access and refresh tokens, single-use refresh rotation,
and revocation. Its exchange and refresh examples omit `expires_in` and instruct
clients to read JWT `exp`, without hard-coding lifetimes.

Switch's generic adapter requires a positive integer `expires_in` and a refresh
token. It does not derive expiry from JWT claims. Confirm the actual DCR
response before deciding whether a separate, reviewed expiry extension is
needed. Do not fabricate `expires_in`, set an arbitrary `max_lifetime`, or treat
an unverified JWT payload as a validated identity. Also verify the token and
revocation endpoints accept Switch's form-encoded requests; the new OAuth
guide illustrates JSON requests.

If the actual tokens never expire, leave the entry disabled, per the
[maintainer's instruction on #835](https://github.com/sandbox-quantum/switch/issues/835).
The personal-token alternative is unsuitable: Switch refuses non-expiring
key connections with `key_never_expires`. There is no key fallback.

[Hosted DCR consent](https://developer.monday.com/api-reference/docs/mcp-dynamic-client-registration)
inherits the authorizing user's platform permissions and admin MCP limits.
The metadata does not advertise board scopes. Do not copy `boards:read` /
`boards:write` from custom-app examples and claim they constrain hosted DCR.
No read-only level is configured. Before enablement, establish a truthful
access-level representation and prove any proposed read-only boundary by
attempting a mutation with it. A skill's instructions do not enforce permissions.

A [custom OAuth app](https://developer.monday.com/api-reference/docs/control-mcp-access-with-oauth-app)
can constrain access with app scopes, but is a distinct registration path.
It requires the app version's **New OAuth flow** toggle and registered redirect
URLs. Existing legacy installs may retain non-expiring tokens. This staged
entry chooses the issue's preferred DCR path, not an operator-owned static app;
there is no client secret file to configure.

## Operator preparation for live QA

1. Use a disposable Monday account with an admin and synthetic boards/items.
   Enable the connecting user's hosted MCP access; connector approval alone
   does not grant it or expand data permissions.
2. Set `FEATURE_FLAGS_ENABLED=service_connections` and a stable HTTPS
   `GATEWAY_PUBLIC_URL` on the test Switch server. The entry selects the
   existing Core redirect mode:
   `<GATEWAY_PUBLIC_URL>/gateway/service-connections/monday/flows/callback`.
   It adds no redirect hosts or OAuth exceptions.
3. After the token and permission blockers have been resolved in code and
   catalog policy, test DCR through Switch. The account admin must approve
   the connection and exact callback URL. Nothing connects while approval is
   pending; after approval, start connect again in Switch Console.
4. Review approval under Monday administration → Connectors → Dynamic
   Connectors. New callback URLs require approval. Core's HTTPS callback
   avoids loopback-port churn and the separate “Allow locally hosted
   connectors” setting. Loopback is not offered by this entry.

See [dynamic connector administration](https://developer.monday.com/api-reference/docs/mcp-dynamic-connectors).
Do not bypass account controls with automatic connector approval.

## Revocation and acceptance checklist

Switch's generic broker stores credentials encrypted and the session host
makes authenticated calls. Credentials must never reach the coding tool's
environment, arguments or files. The identity body is static configuration,
not a template. Retain HTTPS, S256, redirect validation and redaction.

Before enabling the entry, record actual results for:

- DCR, admin approval/rejection, callback validation, consent and the GraphQL
  identity request with the exact issued token. Confirm the identity is stable
  across reconnects and distinguish accounts correctly for multi-account users.
- The exchange and refresh response fields, measured expiry, single-use
  refresh rotation, persistence of the successor pair, and renewal during an
  active session. Set the catalog cap from confirmed behavior and policy.
  Missing or non-expiring credentials must remain refused.
- Actual authenticated `tools/list` schemas and least access. Read a board,
  its schema and items; perform one confirmed update on synthetic data; read
  it back. Verify any supported permission levels with denied operations.
- Grant removal stopping an active room session within a minute while Core
  is reachable, reconnect/re-consent behavior, and vendor permission denial.
- Disconnect calling the discovered revocation endpoint and the resulting
  access/refresh invalidation. Switch currently revokes the refresh token
  preferentially; prove what this does to existing access tokens.
- Removal of Monday admin approval. Monday documents that early-access
  revocation takes effect at refresh and existing access may last up to
  24 hours. This is separate from Switch grant removal; do not promise
  immediate vendor invalidation.
- No credentials in coding-tool env/args/files, transcripts, rooms or logs,
  including failures. Record only redacted lifecycle observations.
- A real video: Console connect → grant → agent uses Monday in a room →
  grant off. Include disconnect and refresh evidence in the QA report.

To roll back an eventual enabled deployment, disable Monday with
`DISABLED_SERVICES`, or restore `enabled: false`. Disconnect existing
connections and verify vendor revocation separately; disabling the catalog
does not prove existing vendor tokens were revoked.

## Implementation validation

Local validation on 2026-11-06:

- Loader, registry, OAuth identity/adapter and gateway catalog suites:
  **242 passed**.
- `just check` and `just typecheck`: passed (639 Python source files checked).
- `just test -q --tb=short -k "'connections or connection_catalog or connector_apps or workspace_services'"`:
  **652 passed, 10215 deselected**. Expensive test runs used
  `flock /home/ubuntu/project/switch-tests.lock`.
- Console desktop `format:check`, `lint` and `typecheck`: passed. Lint reported
  an existing `consistent-type-imports` warning in
  `propagate-server-api-url.db.test.ts`.
- Console node `connection-icon.test.ts`: **38 passed**, after building
  workspace packages. The initial attempt could not resolve the unbuilt
  `@switch-console/agent-providers` package.

The unrestricted backend suite was interrupted after 250 passing tests and
replaced by the relevant selection above; the full repository suite is not
verified. No test assertions failed in the completed runs. These checks use
stand-ins for authenticated provider behavior and do not satisfy live QA.
