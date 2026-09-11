# Phase 2: several workspaces per person

Status: design, not built. Covers `CHOO-2723` (several memberships),
`CHOO-2722` (the tenant API and invitations), `CHOO-2724` (joining by email
domain) and `CHOO-2726` (how anyone becomes an administrator). They are four
tickets and one design: each is a different question about the same object,
and answering them separately produces four answers that do not fit together.

Phase 1 built the boundary. This phase is about crossing it deliberately —
letting one person belong to several tenants, and giving them a way to create,
join and choose between them. Read `multi-tenancy-phase1-db.md` first; this
document assumes its vocabulary and does not repeat it.

## 1. What exists, exactly

- `tenants` — `id`, `slug`, `name`, `created_at`. Nothing else.
- `tenant_members` — `(tenant_id, user_id)` as the primary key, plus `role`
  (`owner` / `admin` / `member`) and `created_at`.
- One tenant exists in every deployment: tenant zero, seeded by migration with
  slug `default`. Sign-in binds it explicitly rather than by fallback.
- `sole_tenant_id()` raises unless the caller has exactly one membership, and
  the gateway turns that into a 403. Zero and two are both refused.
- There is no endpoint that lists, creates or joins a tenant, and no
  invitation of any kind.
- Row-level security policies `tenants` on `id` and `tenant_members` on
  `tenant_id`. A session bound to tenant A reads tenant A's row and **every**
  membership row in A — the policy compares the tenant, not the user, which is
  what makes a member list possible and means any per-person read must filter
  on `user_id` itself.
- `tenants_of_user(user_id)` is one of the seven `SECURITY DEFINER` lookups,
  answering without a tenant bound.
- **`users.role == "admin"` is a global bypass** (`authz.py`, `require_admin`),
  and `users` carries no tenant. `tenant_members.role` is recorded and
  authorises nothing.
- An OIDC identity whose **verified** email matches an existing account is
  **linked** to it and signs in as it, keeping that account's role; only an
  unverified address is refused. There is no `email_verified` column — it is a
  transient property of one callback, never stored.

## 2. The question this phase cannot avoid: which role authorises

Everything else here depends on the answer, and today's answer makes two of
the other sections meaningless.

`authz.can()` decides every owned resource from a `Principal` carrying one
global bit, taken from `users.role`. `tenant_members.role` is written and
never read. So, as things stand:

- **"The creator of a workspace becomes its owner" grants nothing.** Every
  admin-gated route checks the global bit. A person who creates a workspace
  cannot administer it.
- **Any bootstrap that sets the global bit grants too much.** It makes that
  person an administrator of *every* tenant they subsequently join — and §4
  and §5 both add ways to join.

**Chosen: split the two, and make the per-tenant role the one that decides
tenant-scoped things.**

- `users.role == "admin"` keeps its meaning but narrows to what it honestly
  is: a **deployment operator**, the person who runs the server. It stays a
  bypass, it stays global, and nothing self-service can grant it.
- `tenant_members.role` becomes the authorisation input for everything scoped
  to a tenant — rooms, references, documents, packages, agents, keys.
  `authz.can()` takes the caller's role *in the bound tenant*.
- The seeded administrator becomes an operator and an `owner` of tenant zero.
  Everyone else keeps exactly what they have today: a single membership, in
  tenant zero, and the global bit only if they already had it.

This is a bigger change than the other three tickets put together, and it is
the reason they cannot ship without it. It should be its own ticket, sequenced
first. **This is the decision I want confirmed before anything is built.**

## 3. How a request picks its tenant

A request must act in exactly one tenant — Phase 1 depends on that and nothing
here changes it. The question is only how that one is chosen once a person has
several.

**Chosen: the session cookie carries the selection; the database authorises
it.** The gateway's JWT gains a tenant claim. On each request the gateway reads
it, confirms a `tenant_members` row exists for that user and that tenant, and
binds it. Switching workspace is an endpoint that checks membership and
re-mints the cookie.

**The claim selects; it never authorises.** A forged or stale claim buys
nothing, because the membership row is read on every request regardless —
which is what `sole_tenant_id()` already does, with the answer forced to be
unique.

**That statement is true of the browser session and false of everything else,
which is a hole this phase has to close or name.** Bearer credentials resolve
their tenant from the credential's own row — `tenant_of_api_key`,
`tenant_of_agent_oauth_client` — and never consult `tenant_members` at all. So
removing someone from a workspace does not stop the API keys they minted there,
and an agent inherits its owner's permissions whether or not that owner is
still a member. Worse, those keys become invisible to everyone: the key list
runs on the tenant-bound request session, so a key in a workspace you have left
cannot be seen or revoked by you, and its owner is not a member for anyone else
to find it under.

**Chosen: removing a membership revokes that person's keys and disables their
agents in that tenant, in the same transaction.** Anything less makes
"membership" a decoration. If that is judged too large for this phase, then
member removal must not ship either — a removal that leaves working
credentials behind is worse than no removal at all, because it looks like it
worked.

Rejected, for choosing the tenant:

- **A header or path parameter the client sets per request.** Same membership
  check, but the selection becomes ambient in every call, and a caller that
  forgets it silently writes into a different workspace.
- **A subdomain per tenant.** Right eventually; today it forces wildcard
  certificates and a routing story onto self-hosted deployments that are one
  hostname.
- **Deriving it from the resource addressed.** Fails on creation, which names
  no resource.

**Every path that mints the cookie must carry the claim.** There are three —
password login, the OIDC callback, and `/auth/refresh` — and the last is the
one that will be missed: it re-mints from the user alone, so a refresh would
silently drop the selection and drop a multi-workspace person into the
choose-one response mid-session.

## 4. Replacing the single-membership guard

`_resolve_tenant_id` becomes, in order:

1. A tenant claim, and a membership for it → bind it.
2. A tenant claim with no matching membership → 403.
3. No claim, exactly one membership → bind it. This is every session issued
   before the change, and every single-workspace person forever.
4. No claim, several memberships → **409 carrying the list of workspaces**,
   not a guess.
5. No memberships → 403, as today.

Case 4 is the only new failure a client must handle, and it is deliberate:
choosing silently is how someone writes into the wrong workspace without
finding out. **It is also a breaking change for every client at once**, and
Console's workspace switching is explicitly not in this phase. So case 4 ships
behind a flag, or after a Console release that can answer it — not before.

The original design cleared the claim on the 403 in case 2. It should not: the
cookie is `lax`, so a cross-site navigation reaches that path, and any page
could reset someone's selection. Clearing belongs on a dedicated endpoint.

`sole_tenant_id()` and `TenantMembershipError` go. Their tests should be
inverted rather than deleted — "two memberships is an error" is exactly what
this phase must prove it has removed.

## 5. The tenant API

- `GET /tenants` — the caller's workspaces: id, slug, name, their role. §7 is
  about how this reads across the boundary.
- `POST /tenants` — create one; the creator becomes `owner` (meaningful only
  once §2 lands). Slug derived from the name; a taken slug is a 409.
- `POST /tenants/{id}/switch` — verify membership, re-mint the cookie.
- `POST /tenants/{id}/invitations`, `GET`, `DELETE …/{token_id}` — mint, list,
  revoke. `owner` and `admin` only.
- `POST /invitations/{token}/accept` — accept.
- `GET /tenants/{id}/members`, `PATCH …/{user_id}`, `DELETE …/{user_id}` —
  list, change a role, remove. The original design omitted these and then
  assumed the role-change route existed.

**A workspace must always have an owner.** Removing or demoting the last one
is refused; deletion of a workspace is not in this phase, so there is no
legitimate path to an ownerless one.

**Invitations are a table, and a link that grants membership is a credential.**
`id`, `tenant_id`, `role`, `email` (null for a link), `expires_at`,
`uses_remaining`, `revoked_at`, `created_by`, and a hash of the token rather
than the token. Expiry and revocation are not optional.

**Accepting runs in its own tenant-bound session.** The request session is
already stamped with the caller's current workspace; inserting a membership for
a different one on it is refused by the policy, and rebinding it raises. This
is machinery working as intended, but it means the handler cannot be written
like an ordinary one.

**Resolving an invitation needs a lookup.** The table is tenant-scoped, so
finding a token's tenant before any tenant is bound is exactly the read the
policy refuses — the same shape as a bearer token or an OIDC client id. It
needs `tenant_of_invitation(token_hash)`, an eighth `SECURITY DEFINER` lookup
that answers *which tenant* and nothing else, which is the property the
existing seven are built on.

## 6. Joining by email domain

`tenants` gains a domain and a flag: anyone whose verified email is at that
domain may join without an invitation.

**The trap: whoever claims a domain first collects everyone who signs up under
it** — including a consultancy claiming a client's. Three guards:

- The domain must match the **verified** email of the person claiming it.
- A blocklist of public providers. This is the weakest of the three and needs
  a named source — the Public Suffix List plus a maintained free-provider list
  — and an owner, or it fails open at the next new mail host.
- One tenant per domain. The second claim is a 409.

Take the domain after the **last** `@`, lowercased and IDN-normalised.
Subaddressing does not defeat this; sloppy parsing does.

Auto-join should **offer**, not perform, on first sign-in. Landing in a
workspace nobody mentioned, visible to its members, reads as a bug.

**Two of those guards cannot be built today.** There is no `email_verified`
column — verification is a transient property of one callback — and password
accounts are created with an arbitrary address and no proof of control at all.
So this phase must persist verification before it can gate anything on it, and
the guard must treat a password-only account as unverified. Resolving which
tenant claimed a domain also happens before any tenant is bound, so it needs
`tenant_of_email_domain(domain)` — the ninth lookup, same shape as the eighth.

## 7. Listing workspaces without breaking the boundary

`GET /tenants` needs each workspace's name and the caller's role in it, from
two tables a bound session can read for exactly one tenant. The list is
inherently cross-tenant; the policy is inherently not.

The first version of this design proposed looping bound sessions from inside
the handler. **That is wrong**: the request's own session has already issued a
query and holds its transaction, so a second bound session needs a second
connection concurrently — and the suite pins one connection per request with a
single-connection pool precisely to keep that from creeping in.

**Chosen: serve the listing from a path that has no request session open.** It
needs the user id from the token and nothing else, so it authenticates without
binding a tenant, calls `tenants_of_user`, then reads each workspace in one
short bound session at a time, sequentially. One connection at any moment, the
pinned invariant intact. The same routine produces the body of §4's case 4,
which is the same question asked at a different moment.

Still rejected: **a lookup returning names and roles.** The two lookups this
design does add answer *which tenant* — the property that makes the exemption
defensible. One returning tenant names and membership roles to an unbound
session is different in kind, not in degree.

## 8. Becoming an administrator

**A workspace someone creates.** Solved by §5 plus §2: the creator is `owner`,
and once §2 lands that means something.

**A deployment that already exists** — `CHOO-2726`. This is less broken than
previously reported, and the earlier account of it was wrong: identity linking
is **not** refused for a verified address. The seeded administrator is an
ordinary account on the configured administrator address, so an operator who
points that at an address they control at the identity provider, before first
boot, signs in through the identity provider and lands in the administrator
account.

**Chosen: document that as the supported route, and add nothing.** It is
config-driven, set before anyone signs in, and cannot be raced. What it does
not cover is a deployment whose administrator address nobody controls at the
provider — there, an operator still needs database access once.

Rejected: **first person to sign in becomes an administrator.** It hands the
environment to whoever reaches it first during the window every deployment
has.

Note what this does *not* fix: with §2, becoming a deployment operator is
still a database edit or a config value. That is correct — nothing
self-service should mint one.

## 9. What this does not cover

Per-tenant agent registration credentials, tenant switching in Console, the
workspace-versus-server vocabulary question, workspace deletion, and quotas on
workspace creation. That last one deserves a note: `all_tenant_ids()` drives
fan-outs at boot and a sweep every few seconds, so unbounded self-service
creation is an amplification vector. Either cap creation per user or gate the
route by config.

## 10. Done when

- One person holds memberships in two workspaces, and a request acts in
  exactly the one they chose — proven by a test that writes in one and cannot
  read it in the other.
- A person with several memberships and no selection gets the list and a 409,
  never a guess — and a session refresh does not lose their selection.
- A role granted in one workspace grants nothing in another.
- Removing a member stops their keys in that workspace, in the same
  transaction.
- An invitation can be minted, accepted once, and revoked before use.
- A domain cannot be claimed by two tenants, nor by an account that cannot
  prove it uses it.
- The last owner of a workspace cannot be removed or demoted.
