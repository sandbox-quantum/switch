# Multi-tenancy: design and plan

Status: the design, plus the order of work it proposed. Phases 0 and 1 of §8
have since been built; the phases after them have not. Read this for the
reasoning and the shape, and the code for what actually exists — where the two
disagree, the code is right and this page is the record of what was intended.

Switch is single-tenant. One deployment serves one organisation, and a second
organisation means a second deployment stood up by hand. This document
describes what it takes to serve many organisations from one deployment: how a
tenant is modelled, how people sign in and are invited, and how a single
official Slack or Teams app can be installed by any customer and have its
traffic land in the right tenant.

The deliverable was the design and the order of work; no code was written for
it at the time.

## 1. Where we are today

### The substrate is Postgres

Matrix was removed. Sending a message is an insert into `messages`; delivery is
a `pg_notify` hint plus a durable per-agent cursor in `delivery_cursors`. The
transport sits behind a narrow port (`core/switch_core/transport/port.py`) with
one implementation (`transport/postgres.py`).

This matters more than it sounds. Under Matrix, tenant isolation would have
been split across a database and a homeserver, with rooms, users and bridge
puppets living in the homeserver's namespace. Isolation is now a database
question and nothing else, which is why the design below is as small as it is.

Residue: some columns are still named `matrix_room_id` and `matrix_user_id`,
and `SwitchConfig.matrix_server_name` survives as an identifier suffix. Cosmetic,
but worth renaming while touching these tables anyway.

### There is no tenancy of any kind

No tenant, organisation or workspace column exists anywhere in
`core/switch_core`. What exists instead:

- `users.role == "admin"` — a global flag that bypasses every check.
- `owner_id` plus `read_visibility` / `write_visibility` on rooms, references
  and documents, evaluated in `core/switch_core/authz.py`.
- Room groups, which are navigation only.

Two constraints are direct blockers:

- `agents.name` is globally unique. Two customers cannot both have an agent
  called `reviewer`.
- `users.email` is globally unique. Reasonable today; wrong once one person can
  belong to two tenants.

### Authentication

Humans authenticate by bcrypt password or OIDC
(`core/switch_core/gateway/oidc_routes.py`), and both paths mint the same HS256
JWT into an httpOnly cookie. Agents authenticate with a bearer token hashed
against `api_keys.key_hash`. Agent registration is gated by
`agent_registration_token` — **one shared secret for the whole deployment**.

### Bridges

Bridge credentials already live in the database rather than in environment
variables: one `collaboration_bridges` row per connection, tokens in a
Fernet-encrypted JSONB config. But a bridge is explicitly an admin-owned,
deployment-wide integration, and there is no OAuth install flow for Slack —
an operator pastes a bot token in. Inbound Slack events arrive over Socket
Mode, one long-lived connection per bridge row, and are routed to a room by
`rooms.external_channel_id`.

### Deployment

Four environments (`pilot`, `development`, `demo`, `public`) live in the
internal `napoleon` repository, separated by Helm release and namespace on one
EKS cluster, each with its own in-namespace Postgres. Every deploy is a manual
`just` command. The pilot is documented as a single-tenant deployment.

## 2. The tenant model

### Shape

A tenant is an organisation. A person has one login and may belong to several
tenants; membership carries a role.

```
tenants
  id, slug (unique), name, plan, status, created_at, deleted_at

tenant_members
  tenant_id, user_id, role (owner|admin|member), created_at
  primary key (tenant_id, user_id)
```

**Membership is a row, not a column on the user.** This is the single most
consequential modelling decision here. A `users.tenant_id` column is simpler
today and wrong within a year: consultants belong to two customers, and support
staff need to enter a customer's tenant. Retrofitting a join table after the
fact means rewriting every query that assumed one tenant per user.

Every scoped table gains a `tenant_id` foreign key: `rooms`, `agents`,
`clients`, `messages`, `references`, `documents`, `packages`, `tasks`,
`api_keys`, `collaboration_bridges`, `room_groups`, `agent_sessions`,
`external_users`. Global tables — `reference_types` for built-ins,
`feature_flags`, `models` — do not.

### Uniqueness becomes per-tenant

- `agents.name` → unique on `(tenant_id, name)`.
- `users.email` stays globally unique, because a user is a person, not a tenant
  member. The per-tenant object is the membership row.
- `rooms.external_channel_id` is already unique per bridge; since a bridge will
  belong to a tenant, that becomes per-tenant transitively.

Agent addressing (`@name` in a room) resolves within a room, and a room belongs
to one tenant, so per-tenant agent names need no change to addressing itself.

### Enforcement in one place

The failure mode for shared-database multi-tenancy is a single query missing
its filter. Code review does not reliably catch this; it must be structural.

Recommended: **Postgres row-level security**, with the tenant set as a session
variable at the start of every request and policies on each scoped table. A
query that forgets its filter returns nothing rather than another customer's
rows, and the guarantee holds for code that has not been written yet.

The alternative — a tenant-aware session or base query class that every store
must use — is less work but relies on developers doing the right thing, and the
first place someone drops to raw SQL is the first leak. Given the codebase is
already a small number of store classes with a shared session, RLS is the
better fit, with the tenant-scoped session as the mechanism that sets the
variable.

Non-negotiable either way: the tenant comes from the authenticated principal,
never from a request parameter. No endpoint accepts a tenant id as input.

### Migration

The existing deployment becomes tenant zero. As one explicit migration: create
the tenants table, insert one row, add `tenant_id` as nullable, backfill every
row to it, then make it non-nullable. Doing this as a single deliberate step is
much cleaner than leaving nullable tenant columns in the schema indefinitely.

Once customers exist, schema changes must be expand-then-contract — add the
column, deploy code writing both, backfill, drop the old — because migration
and deploy are separate steps and each version of the code must tolerate the
other's schema.

## 3. Sign-in and onboarding

### Provider: WorkOS

The provider answers *who is this person*. It must not own *what they belong
to* — tenants, membership and roles stay in our database, keyed to a verified
identity. A provider that owns the tenant boundary makes multi-tenant users
awkward and makes leaving expensive.

WorkOS over Firebase, for two reasons. It speaks standard OIDC, so it fits the
login path the gateway already has, where Firebase issues its own token format
and would need a bespoke verification path. And enterprise SSO (Okta, Entra,
SAML, SCIM) is a first-class part of the product rather than an upsell into
Google Cloud Identity Platform. Switch sells to companies — the pilot is itself
an Okta deployment — so SSO is a matter of when, and retrofitting SAML is
unpleasant.

Ordinary Google, GitHub and password sign-in work identically on both;
individuals are not excluded. WorkOS is free to a high user count, with
per-connection pricing for enterprise SSO, so cost lands on customers who are
already paying.

**Accounts are keyed on the verified email address, not on the login method.**
Someone who signs up with a password and later signs in with Google must land
in the same account. Keying on the provider's subject identifier instead turns
any later change of login policy into a manual account merge.

### Sign-up

Sign in → land on "create your workspace" → name it → become its owner. The
tenant is created at sign-up, never implicitly by an app install.

If the email domain matches an existing tenant, offer to request to join it
rather than silently creating a second one. This is the fix for the most common
real-world mess — two colleagues signing up separately and splitting their
company across two tenants — and it is far cheaper to build now than to
reconcile later. (The Slack-side variant of this is deferred; see §4.)

### Invitations

Two kinds, both wanted:

- **Email invite** — bound to one address, single use.
- **Shareable link** — anyone with it joins, optionally restricted to an email
  domain.

Both are a row: token, tenant, role, expiry, uses remaining, revoked flag. A
link that grants membership is a credential, so expiry and revocation are
required, not optional. Accepting while signed in adds the membership;
accepting signed out routes through sign-up first.

### Agent registration

`agent_registration_token` is one shared secret today, so any holder could
register agents into any tenant. It becomes a per-tenant credential, issued and
revocable from the tenant's settings. This is a genuine security blocker, not a
refactor.

### Linking a chat identity to a Switch account

Someone who has only ever talked to an agent in Slack has an `external_users`
puppet, not a login. Connecting the two needs a one-time link proving both
sides are the same person — the same mechanism as an invitation, issued to a
known external user.

### Deferred

Sign-in from switchdash. A desktop app doing OAuth needs a loopback redirect
and local token storage; it is meaningfully more work than a web page and is
not on the critical path.

## 4. Official messaging apps

### Why

Today each deployment needs its own Slack app: someone creates it in Slack's
developer settings, copies two tokens, and pastes them into Switch. That does
not scale to customers. The goal is one Slack app owned by us, which a customer
adds to their workspace with a click.

### The install flow

One person, one browser, three screens:

1. **In Switch**, signed in to their tenant, they click *Connect Slack*. Switch
   generates a random single-use `state` value, stores `state → tenant, user,
   expiry`, and redirects to Slack's authorise URL carrying it.
2. **On slack.com**, Slack shows the permission screen — this is Slack's page,
   not ours; we cannot pre-approve it. If the workspace requires admin approval
   for apps, Slack enforces that here. The user picks the workspace and
   approves. *This click is the install.*
3. **Back in Switch**, Slack redirects with the `state` and a one-time code. We
   exchange the code for a bot token scoped to that workspace, look up `state`
   in our own store to learn the tenant, and record the install.

The security property is that the two halves come from different places and
neither is user-supplied: **Slack answers "which workspace", we answer "which
tenant"**. There must be no endpoint that accepts a workspace id as input —
workspace ids are not secret, so anything that accepts one as a claim lets an
attacker claim another company's Slack.

### Storing installs

```
messaging_installs
  id, tenant_id, platform, external_workspace_id, encrypted_bot_token,
  installed_by_user_id, scopes, status, installed_at
  unique (platform, external_workspace_id)
```

The unique constraint is the point: one workspace maps to exactly one tenant,
enforced by the database rather than by a check in application code, so two
tenants racing for the same workspace is an impossible state rather than a
logic bug.

Bot tokens are per-app-per-workspace: one Slack app installed in fifty
companies yields fifty tokens, each valid only in its own workspace. Every
outbound Slack call must take its token from the install row of the tenant it
is acting for, and from nowhere else. This is the boundary where a mistake
posts one customer's data into another customer's Slack.

The existing `collaboration_bridges` row remains for self-hosted operators who
bring their own app; `messaging_installs` is the hosted path. The two coexist.

**When a workspace is already claimed**, the install fails with a clear message
naming the situation. A request-to-join flow is the right answer and is
deliberately deferred until the rest works.

### Inbound events

Slack does not support Socket Mode for publicly distributed apps, so the hosted
app cannot use the transport the adapter is built around. It needs a second
inbound path: one public HTTPS endpoint receiving events from every workspace,
verifying Slack's request signature, resolving `team_id` to an install and
therefore a tenant, and handing the event to the existing routing.

This is stateless and scales without connections. Socket Mode stays for
self-hosted, bring-your-own-app deployments. Both feed the same
`BridgeCore._handle_inbound_message` path once the tenant is resolved.

Teams already does OAuth, but against a single app registration; it needs the
same per-install storage. Discord and Telegram each have their own equivalent
of the install click.

## 5. Quotas, metering and abuse

Every agent turn costs LLM money, so one customer's runaway loop is our bill.
Quotas are a cost control before they are an abuse control.

- **Meter per tenant**: messages, agent turns, tokens. The numbers are needed
  before billing is, and they cannot be backfilled.
- **Enforce with a hard stop.** When a tenant is out of budget, the platform
  refuses. A limit that only alerts is not a limit. This mechanism is shared by
  the free tier and by paid plan ceilings, so it is worth building once, early.
- **Free tier**: a small token budget, cheap models only, few agents.

On abuse of a free tier: a verified email is not a scarce resource, so
per-account limits are bypassable by anyone deliberate. The practical answer is
to make farming accounts not worth it rather than to prevent it — cap what a
free tenant can spend rather than how many can exist, block disposable email
domains, rate-limit sign-ups per IP, and prefer social login (throwaway Google
accounts need a phone number, which is genuinely scarce). A card on file for
anything beyond a trivial tier is the real answer whenever the product is ready
for it.

## 6. Platform work this depends on or implies

Not part of the tenant model, but on its critical path:

- **Migrate Postgres to RDS before multi-tenancy, not after.** In-namespace
  Postgres on a PVC is fine for a pilot; customer data needs provable backups
  and point-in-time recovery, and migrating a database with live tenants on it
  is far worse than migrating one now.
- **Tenant id on every log line and error report.** Retrofitting this is
  miserable, and without it "is this one customer or everyone?" is
  unanswerable.
- **Per-tenant roles** (owner/admin/member) replacing reliance on the global
  `admin` flag.
- **Audit log** — who invited whom, who connected Slack, who deleted an agent.
- **Support access** — an explicit impersonation path with an audit trail.
  "We'll query the database" does not survive a security review.
- **Tenant deletion** — a legal requirement, and much harder to add once data
  is spread across twenty tables.

Deployment, agreed alongside this spike and tracked separately:

- Promotions as an approved commit, with Argo CD reconciling from a directory
  in `napoleon`. The commit history becomes the record of what is deployed
  where, which is what is missing today.
- Deploy credentials off laptops: the deploy agent becomes a requester that
  triggers CI, not an executor holding cluster credentials.
- `demo` stays a separate deployment rather than a free tenant inside prod, to
  limit blast radius.
- Per-environment messaging apps — staging must not share a Slack app with
  prod, or a staging bug posts into customer channels.
- Later: e2e smoke tests in CI, Datadog SLAs.

## 7. Decisions

| Decision | Chosen | Alternative and why not |
|---|---|---|
| Isolation | Shared database, `tenant_id` on every scoped table | Database per tenant — better isolation, far worse operationally (migrations across N databases). Nothing here prevents moving one large customer out later. |
| Scope enforcement | Row-level security in Postgres | A tenant-aware query layer relies on developers remembering; RLS fails closed for code not yet written. |
| Membership | Join table, user ↔ tenant with role | `users.tenant_id` — simpler now, blocks multi-tenant users and support access, expensive to unpick. |
| Auth provider | WorkOS | Firebase — cheaper and faster, but not standard OIDC and weak on enterprise SSO. |
| Account key | Verified email | Provider subject id — forces manual merges if login policy changes. |
| Tenant creation | Sign up in Switch first, then connect a workspace | Install-creates-tenant — no signed-in identity to bind to, needs provisional tenants and later proof of ownership. |
| Workspace already claimed | Dead end with a clear error | Request-to-join — the right answer, deferred until the flow works. |
| Demo environment | Separate deployment | A free tenant in prod — one thing to run, but puts strangers in the paying customers' database. |
| switchdash sign-in | Deferred | Not on the critical path. |

## 8. Plan

Ordered so each phase is useful on its own and unblocks the next. Slack is last
because it is the only piece that needs all three others to exist.

**Phase 0 — prerequisites.** Migrate to RDS. Add tenant id to logging. Neither
touches the model; both get much harder later.

**Phase 1 — tenant model.** Tenants and membership tables, `tenant_id` on
scoped tables, the tenant-zero migration, per-tenant uniqueness, RLS with the
tenant set from the authenticated principal. Invisible to users: the existing
deployment carries on as one tenant. Everything else depends on it.
*Done when:* an integration test proves tenant A cannot read tenant B's rows
through the ordinary application paths.

**Phase 2 — sign-in and tenants as a product.** WorkOS on the existing OIDC
path, sign-up creating a tenant, per-tenant roles, invitations by email and
link, per-tenant agent registration credentials, tenant switching in the UI.
*Done when:* a new customer can sign up, invite a colleague and register an
agent without an operator.

**Phase 3 — quotas and metering.** Per-tenant usage counters, plan limits, the
hard stop, free-tier defaults and sign-up friction.
*Done when:* a tenant that exhausts its budget is refused, and usage per tenant
is visible.

**Phase 4 — official Slack app.** The OAuth install flow, `messaging_installs`,
the public webhook path with signature verification and workspace-to-tenant
routing, coexisting with Socket Mode for self-hosted.
*Done when:* a customer can add Switch to their Slack from within Switch and
talk to their own agents, with no operator involvement.

**Phase 5 — the rest of the platform.** Teams and Discord installs on the same
pattern, audit log, tenant deletion, support impersonation, request-to-join,
billing.

## Open questions

- Does any enterprise customer contractually require their own database? The
  answer changes phase 1 from "shared with an escape hatch" to "both from the
  start".
- Which environments get the WorkOS redirect URIs registered up front? Okta
  works only on the pilot today precisely because this was not done, and the
  other three fall back to passwords.
- Does the free tier need a card on file at launch, or is a small budget
  enough to start?
