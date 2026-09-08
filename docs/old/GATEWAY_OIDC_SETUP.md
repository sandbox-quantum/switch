# Gateway OIDC sign-in setup

The gateway (the operator dashboard's backend, mounted at `/gateway`) has a
complete generic OIDC browser sign-in path — bring your own identity provider,
no code changes. It is enabled purely by configuration
(`core/switch_core/config.py`, `core/switch_core/gateway/oidc_routes.py`), and
works against any standards-compliant IdP that publishes OIDC discovery
metadata (Okta, Keycloak, Auth0, WorkOS Connect, …). This page covers the
variables, the registration steps a provider needs from you, and one
WorkOS-specific trap that will otherwise cost you an afternoon.

OIDC login is additive: password login (`GATEWAY_ADMIN_EMAIL` /
`GATEWAY_ADMIN_PASSWORD` and any user created under it) keeps working unless
you explicitly turn it off with `GATEWAY_PASSWORD_LOGIN_ENABLED=false`.

## The variables

| Variable | Required | What it does |
| --- | --- | --- |
| `GATEWAY_OIDC_ISSUER_URL` | yes* | The IdP's issuer. The gateway appends `/.well-known/openid-configuration` to it and discovers the authorize, token, JWKS and (where published) userinfo endpoints from there — nothing else about the provider is configured by hand. |
| `GATEWAY_OIDC_CLIENT_ID` | yes* | The client id registered with the IdP for this application. |
| `GATEWAY_OIDC_CLIENT_SECRET` | yes* | The client secret for that same registration. |
| `GATEWAY_OIDC_SCOPES` | no, but see below | Space-separated OAuth scopes requested at authorize time, e.g. `openid profile email`. |
| `GATEWAY_OIDC_REDIRECT_URL` | no, but see below | The absolute callback URL registered with the IdP. |
| `GATEWAY_OIDC_PROVIDER_LABEL` | no | Text shown on the login button ("Log in with `<label>`"). Defaults to "SSO" if unset. |
| `GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED` | no | Defaults to `true`. See "What turning this off means" below. |

*\*All-or-nothing.* `GATEWAY_OIDC_ISSUER_URL`, `GATEWAY_OIDC_CLIENT_ID` and
`GATEWAY_OIDC_CLIENT_SECRET` are validated as a group at startup: set all
three or none of them. Setting one or two without the rest fails config
construction immediately (`Partial gateway OIDC config: set all of
GATEWAY_OIDC_ISSUER_URL / GATEWAY_OIDC_CLIENT_ID / GATEWAY_OIDC_CLIENT_SECRET,
or none of them.`) rather than starting up with OIDC silently disabled. OIDC
is considered configured (`gateway_oidc_enabled`) exactly when all three are
set; every other variable in the table is independently optional and has a
default.

### Scopes: always set this, and quote it

`GATEWAY_OIDC_SCOPES` has no default — if you don't set it, the gateway asks
authlib to request an unspecified scope, which most providers resolve to
whatever their own default is. Set it explicitly, and **make sure it includes
`openid`**: without that scope the token response carries no `id_token`, and
the callback is left asking the provider's userinfo endpoint for claims
instead — which some providers answer and some refuse.

Quote the value in your env file. `GATEWAY_OIDC_SCOPES=openid profile email`
(unquoted, with spaces) breaks `just`'s env-file parser — every recipe loads
`.env` through it (`set dotenv-load := true` in the justfile), and it fails
loudly: `error: failed to load environment file ... Error parsing line`, exit
1, the recipe never runs. That protection only applies through `just`,
though: running `uv run python -m switch_core.main` directly skips it
entirely. Plain `uv run` doesn't read `.env` at all, so the variable is
simply unset there; `uv run --env-file .env` reads it but only warns on the
bad line and continues. Either way, going around `just` trades the loud
parse error for a silent one: `GATEWAY_OIDC_SCOPES` ends up unset, and the
provider is asked for whatever scope it defaults to instead — with nothing
pointing back at the scope configuration if that default happens not to
include `openid`. Write it as:

```
GATEWAY_OIDC_SCOPES="openid profile email"
```

### The redirect URL

`GATEWAY_OIDC_REDIRECT_URL` is technically optional: if you leave it unset,
the login route builds the callback URL from the incoming request
(`request.url_for("oidc_callback")`). That only works when the gateway sees
the same scheme and host the browser used — behind a reverse proxy or a
Tailscale funnel it usually doesn't, so set it explicitly for anything other
than a bare local server. Set it always if you're not sure.

The real path, mounted where the gateway app lands on the root ASGI app, is
**`/gateway/auth/oidc/callback`**. A full value looks like
`https://switch-gateway.example.com/gateway/auth/oidc/callback` (or, for a
local dev server hit directly on its own port,
`http://localhost:8000/gateway/auth/oidc/callback`). It has to match the
value registered with the IdP **character for character** — scheme, host,
port and path — or the provider refuses the callback before Switch ever sees
it.

### What turning off email-verified enforcement means

By default, a login is refused unless the IdP's token asserts
`email_verified: true` on the claim Switch is about to trust for
just-in-time provisioning (see below). This exists because provisioning
binds a brand-new local account to whatever email the token carries, and an
email address on its own proves nothing unless the IdP has confirmed the
holder controls it. If an IdP lets a user self-assert or change their own
address without verifying it, anyone who can complete a login can provision
a Switch account under an email they don't own — including one a real
colleague hasn't signed in with yet. Switch already refuses to create a
second account over one that's already claimed (see the conflict rule
below), so this isn't a way to take over an existing account, but it does
let an attacker squat an unclaimed address first, and the genuine owner's
first real login then hits that same conflict and is locked out instead of
provisioned. Separately, some providers *never* set the claim true for
directory-provisioned users, which would lock every one of them out
permanently if left at the default.

`GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED=false` is the escape hatch for that
second case. Set it only when the IdP's addresses are authoritative on their
own — a single-tenant corporate directory or HR-provisioned identity source
— never for an IdP where a user can set their own email. Turning it off is a
real reduction in the guarantee behind every OIDC-provisioned account's
email address, not a cosmetic toggle.

## First sign-in: what gets provisioned

On the first successful login from a given IdP identity, the gateway
provisions a user just-in-time: a local `user`-role account, no password
hash, bound to the immutable `(issuer, subject)` pair from the token — never
to the mutable email address. This is the behavior on `main` today
(`core/switch_core/db/stores/user_store.py`); it may change as the identity
model evolves, so check that file if this page has drifted.

Two things worth knowing before your first login:

- **It is deliberately not linked to an existing local account with the same
  email.** If a password-authenticated account already owns that email
  address, the OIDC login is refused with a conflict rather than silently
  taking over the account — auto-linking by email is an account-takeover
  vector (a token asserting someone else's email would otherwise inherit
  their account, including a seeded admin's). There is currently no
  self-service linking flow; a conflicting account has to be resolved by an
  admin.
- **Every OIDC-provisioned user gets the `user` role**, never `admin`.
  Promote it by hand afterwards if it needs elevated access.

## Setting up WorkOS as the provider

This is the part that will otherwise burn an afternoon. WorkOS exposes two
different sign-in surfaces, and only one of them is a standards-compliant
OIDC provider that this gateway (or any generic OIDC client) can use.

**The one that looks right but isn't: WorkOS User Management.**
`https://api.workos.com/user_management/<client_id>` serves a
`.well-known/openid-configuration` document, so it passes the first sanity
check — discovery succeeds, the gateway registers the client without
complaint. But the token response carries no `id_token`, and the discovery
document publishes no `userinfo` endpoint either; profile data comes back
through WorkOS's own proprietary User Management API instead. A generic OIDC
client has nowhere to read claims from, and every login fails at the
"OIDC token missing email or sub claim" check. Nothing about the discovery
step tells you this in advance.

**The one that actually works: WorkOS Connect.** The spec-compliant surface
lives at the environment's **AuthKit domain**, `https://<slug>.authkit.app`.
It publishes a proper `id_token` (RS256-signed), a `userinfo` endpoint, JWKS,
and standard scope handling — this is what `GATEWAY_OIDC_ISSUER_URL` should
point at, never the `user_management` URL above.

Connect has its **own, separate client registry**, distinct from the User
Management client id you'd otherwise reach for:

1. In the WorkOS dashboard, create a **Connect OAuth application** — type
   **OAuth**, **confidential**. This is a different object from anything in
   the dashboard's AuthKit **Applications** list; it will not appear there,
   and that mismatch is the single most common source of confusion when
   setting this up. If you try to reuse the User Management client id
   against the AuthKit domain instead, WorkOS rejects it with
   `application_not_found` — the two registries don't share ids.
2. Register your redirect URI (`.../gateway/auth/oidc/callback`, see above)
   on that Connect application.
3. Generate the application's client secret **in the dashboard**. This step
   has no API path: the WorkOS MCP server exposes
   `deleteApplicationCredential` but nothing to create one, and the REST
   Applications API documents no credentials endpoint. Dashboard only.
4. Set `GATEWAY_OIDC_ISSUER_URL` to the AuthKit domain
   (`https://<slug>.authkit.app`), and `GATEWAY_OIDC_CLIENT_ID` /
   `GATEWAY_OIDC_CLIENT_SECRET` to the Connect application's credentials.

**Finding the AuthKit domain for an environment.** If you don't already know
it, call the User Management authorize endpoint with the User Management
client id and read where it redirects you — it lands on the AuthKit domain
for that environment:

```
GET https://api.workos.com/user_management/authorize?client_id=<user_management_client_id>&response_type=code&redirect_uri=<any_uri>
```

Read the `Location` header of the redirect response; the host is your
AuthKit domain.

Recommended scopes for WorkOS Connect: `GATEWAY_OIDC_SCOPES="openid profile
email"` (quoted, per the warning above).

## Verifying it end to end

1. Set the three required variables plus `GATEWAY_OIDC_SCOPES` and
   `GATEWAY_OIDC_REDIRECT_URL`, and restart the server.
2. `GET /gateway/auth/config` should report `oidc_enabled: true` and your
   `oidc_provider_label` (or `null`, which the login page shows as "SSO").
3. Visiting the login page should show a "Log in with `<label>`" button
   alongside the password form (unless you disabled password login). Signing
   in should land you back on `FRONTEND_BASE_URL` with a `switch_auth`
   session cookie set.
