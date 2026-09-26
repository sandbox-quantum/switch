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
| `GATEWAY_OIDC_SCOPES` | yes* | Space-separated OAuth scopes requested at authorize time, e.g. `openid profile email`. Must include `openid`. |
| `GATEWAY_OIDC_REDIRECT_URL` | no, but see below | The absolute callback URL registered with the IdP. |
| `GATEWAY_OIDC_PROVIDER_LABEL` | no | Text shown on the login button ("Log in with `<label>`"). Defaults to "SSO" if unset. |
| `GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED` | no | Defaults to `true`. See "What turning this off means" below. |

*\*All-or-nothing.* `GATEWAY_OIDC_ISSUER_URL`, `GATEWAY_OIDC_CLIENT_ID`,
`GATEWAY_OIDC_CLIENT_SECRET` and `GATEWAY_OIDC_SCOPES` are validated as a
group at startup: set all four or none of them. Setting some without the rest
fails config construction immediately (`Partial gateway OIDC config: set all
of GATEWAY_OIDC_ISSUER_URL / GATEWAY_OIDC_CLIENT_ID /
GATEWAY_OIDC_CLIENT_SECRET / GATEWAY_OIDC_SCOPES, or none of them.`) rather
than starting up with OIDC silently disabled. OIDC is considered configured
(`gateway_oidc_enabled`) exactly when all four are set; every other variable
in the table is independently optional and has a default.

### Scopes: required, must include `openid`, and quote it

`GATEWAY_OIDC_SCOPES` has no default, and OIDC will not start without it: it
is part of the all-or-nothing group above, and a value that does not include
`openid` is refused at startup with its own error. Both refusals exist for
the same reason — without that scope the token response carries no
`id_token`, and the callback is left asking the provider's userinfo endpoint
for claims instead, which some providers answer and some refuse. Failing to
boot is better than a login path that works against one provider and not the
next.

Quote the value in your env file. `GATEWAY_OIDC_SCOPES=openid profile email`
(unquoted, with spaces) breaks `just`'s env-file parser — every recipe loads
`.env` through it (`set dotenv-load := true` in the justfile), and it fails
loudly: `error: failed to load environment file ... Error parsing line`, exit
1, the recipe never runs. That protection only applies through `just`,
though: running `uv run python -m switch_core.main` directly skips it
entirely. Plain `uv run` doesn't read `.env` at all, so the variable is
simply unset there; `uv run --env-file .env` reads it but only warns on the
bad line and continues. Either way, going around `just` leaves
`GATEWAY_OIDC_SCOPES` unset — which the startup check above now catches,
refusing to boot rather than quietly asking the provider for whatever scope
it defaults to. The error names the group rather than the quoting, so if you
see it and believe you set the value, suspect the line. Write it as:

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

Three things worth knowing before your first login:

- **An existing local account with the same email is linked, not refused —
  provided the IdP says the address is verified.** The identity is attached to
  that account and the person signs in as it, keeping its role, its rooms and
  its password. An *unverified* address is refused with a conflict instead,
  because auto-linking on an unverified claim is an account-takeover vector: a
  token asserting someone else's address would otherwise inherit their
  account. The whole guard is therefore the `email_verified` claim, which is
  why the setting above is not cosmetic — turning it off removes the only
  thing standing between a claimed address and the account that owns it.
- **That is also the supported way to have an administrator who signs in
  through the IdP.** The seeded administrator is an ordinary account on
  `GATEWAY_ADMIN_EMAIL`; set that to an address you control at the identity
  provider before first boot, and signing in through the IdP lands you in it
  with its `admin` role. Point it at an address nobody can claim and there is
  no such route.
- **Anyone provisioned fresh gets the `user` role**, never `admin` — that
  applies to a new account, not to one linked as above. Promote it by hand
  afterwards if it needs elevated access.

### Which workspace a new account lands in

`GATEWAY_SIGNUP_MODE` decides this. The Helm chart sets it from
`switchCore.signup.mode`.

| Mode | A new account | Creating a workspace |
| --- | --- | --- |
| `default_tenant` (default) | joins the default workspace as a member | allowed, up to the cap |
| `open` | joins nothing, and is asked to create a workspace or accept an invitation | allowed, up to the cap |
| `invite_only` | joins nothing, and can get in only by accepting an invitation | operators only |

The cap is `GATEWAY_MAX_WORKSPACES_PER_USER`
(`switchCore.signup.maxWorkspacesPerUser`, default 3; `0` turns self-service
creation off). It counts the workspaces a person has created, not ones they
were invited to, and handing one over does not give the allowance back.
Deployment operators are exempt.

Your identity provider still decides who can sign in at all. With `open`,
anyone the provider lets through can create a workspace. If the server should
not be open to the world, use a provider that restricts sign-in. Changing the
mode does not affect existing accounts; they keep their memberships.

A person who belongs to several workspaces goes back to the one they used last
when they sign in, as long as they are still a member of it. If there is no
such workspace, the dashboard asks them to choose. Other API clients get a 403
on workspace routes until they pick one with `POST /tenants/{id}/switch`. If
`GATEWAY_TENANT_CHOICE_ENABLED` (`switchCore.tenantChoiceEnabled`) is set, they
get a 409 listing the workspaces instead.

### Invitation e-mails

A workspace admin can invite someone by e-mail address from the Workspace
page. With an SMTP relay configured, Switch sends that person an e-mail with a
link. They open it, sign in (or sign up through the provider), accept, and are
a member of the workspace. Any relay that speaks SMTP works: Amazon SES's SMTP
interface, Postmark, SendGrid, or your own.

| Variable | Helm value | Meaning |
| --- | --- | --- |
| `GATEWAY_SMTP_HOST` | `switchCore.smtp.host` (and `smtp.enabled: true`) | the relay; setting it turns e-mail on |
| `GATEWAY_SMTP_PORT` | `switchCore.smtp.port` | default 587 |
| `GATEWAY_SMTP_TLS` | `switchCore.smtp.tls` | `starttls` (default, port 587), `tls` (port 465), or `none` for a relay on a trusted network |
| `GATEWAY_SMTP_USERNAME` / `GATEWAY_SMTP_PASSWORD` | `switchCore.smtp.username` / `secrets.gatewaySmtpPassword` | set both or neither |
| `GATEWAY_SMTP_FROM` | `switchCore.smtp.from` | the From address, e.g. `Switch <invites@your-domain>` |
| `GATEWAY_INVITE_EMAILS_PER_DAY` | `switchCore.smtp.emailsPerDayPerWorkspace` | default 50 |

The link points at `FRONTEND_BASE_URL` (`switchCore.frontendBaseUrl`), which is
required once a host is set. The server refuses to start without it, rather
than building links from whatever `Host` header a request arrived with. The
token travels in the link's fragment (`/invite#token=…`), which browsers do
not send to servers, so it stays out of access logs.

The invitation is created whether or not the e-mail goes out, and the admin
always sees what happened:

- **Sent**: "Invitation e-mailed to …". The link is shown as well.
- **No relay configured**: the invitation is created, the dashboard says no
  e-mail was sent and shows the link to share, and the server logs a warning.
- **The relay refused or could not be reached**: the same, with the error in
  the server log.

An invitation addressed to an e-mail can be accepted only by someone signed in
with that address. Each workspace may send at most
`GATEWAY_INVITE_EMAILS_PER_DAY` addressed invitations in 24 hours; past that
the dashboard asks the admin to try tomorrow or share a link. This matters
with `open` sign-up, where anyone can own a workspace and would otherwise be
able to use your relay to mail any address. Operators are exempt, and link
invitations are not counted.

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

1. Set the four required variables plus `GATEWAY_OIDC_REDIRECT_URL`, and
   restart the server.
2. `GET /gateway/auth/config` should report `oidc_enabled: true` and your
   `oidc_provider_label` (or `null`, which the login page shows as "SSO").
3. Visiting the login page should show a "Log in with `<label>`" button
   alongside the password form (unless you disabled password login). Signing
   in should land you back on `FRONTEND_BASE_URL` with a `switch_auth`
   session cookie set.
