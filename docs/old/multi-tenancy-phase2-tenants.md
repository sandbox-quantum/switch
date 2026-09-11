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
- `tenant_members` — `(tenant_id, user_id)` as the primary key, plus a `role`
  constrained to `owner` / `admin` / `member`. The roles are recorded and mean
  nothing yet.
- One tenant exists in every deployment: tenant zero, seeded by migration with
  slug `default`. Sign-in binds it explicitly rather than by fallback.
- `sole_tenant_id()` raises unless the caller has exactly one membership, and
  the gateway turns that into a 403. Zero memberships and two memberships are
  both refused. The comment says why: in Phase 1 exactly one is the only
  correct state, and two is Phase 2 arriving early.
- There is no endpoint that lists, creates or joins a tenant, and no
  invitation of any kind.
- Row-level security policies `tenants` on `id` and `tenant_members` on
  `tenant_id`, so a session bound to tenant A can read tenant A's row and its
  own membership rows, and nothing about tenant B.
- `tenants_of_user(user_id)` already exists as one of the seven
  `SECURITY DEFINER` lookups, returning tenant ids for a user without a tenant
  bound.

## 2. The decision that shapes everything: how a request picks its tenant

A request must act in exactly one tenant — Phase 1 depends on that and nothing
here changes it. The question is only how that one is chosen once a person has
several.

**Chosen: the session cookie carries the selection; the database authorises
it.** The gateway's JWT gains a tenant claim. On each request the gateway reads
it, confirms a `tenant_members` row exists for that user and that tenant, and
binds it. Switching workspace is an endpoint that checks membership and
re-mints the cookie.

The distinction that matters, and the reason this is safe: **the claim selects,
it never authorises.** A forged or stale claim buys nothing, because the
membership row is read on every request anyway — which is what
`sole_tenant_id()` already does today, only with the answer forced to be
unique. Revoking someone's membership takes effect on their next request, not
when their cookie expires.

Rejected, and why:

- **A header or path parameter the client sets per request.** Same membership
  check, but the selection becomes ambient in every client call rather than
  session state, and every caller that forgets it gets a different tenant than
  the last one. The failure is silent and the blast radius is writes.
- **A subdomain per tenant.** Right eventually, wrong now: it forces wildcard
  certificates and a routing story on self-hosted deployments that today are
  one hostname, for no gain the cookie does not give.
- **Deriving it from the resource being addressed.** Reads plausibly, fails on
  creation — a request that creates the first room in a workspace names no
  resource to derive from.

## 3. Replacing the single-membership guard

`_resolve_tenant_id` becomes, in order:

1. A tenant claim in the token, and a membership for it → bind it.
2. A tenant claim with no matching membership → 403, and clear the claim so
   the next request is the no-claim case rather than looping.
3. No claim, exactly one membership → bind it. This is every session issued
   before this change, and every ordinary single-workspace person forever.
4. No claim, several memberships → **409 with the list of workspaces**, not a
   guess. The client picks and calls the switch endpoint.
5. No memberships → 403, as today.

Case 4 is the only new failure a client must handle, and it is a deliberate
one: picking for someone silently is how a person writes into the wrong
workspace and does not find out.

`sole_tenant_id()` and `TenantMembershipError` disappear with it. Their tests
should not be deleted — they should be inverted, because "two memberships is
an error" is exactly the behaviour this phase must prove it has removed.

## 4. The tenant API

Six routes on the gateway, all under the caller's own identity.

- `GET /tenants` — the caller's workspaces: id, slug, name, their role.
  **This is the one read that genuinely crosses the boundary**, and §6 is
  about how.
- `POST /tenants` — create one. The creator becomes `owner`. Slug is derived
  from the name and must be unique; a taken slug is a 409, not a silent
  suffix.
- `POST /tenants/{id}/switch` — verify membership, re-mint the cookie.
- `POST /tenants/{id}/invitations` — mint one. `owner` and `admin` only.
- `GET /tenants/{id}/invitations` / `DELETE …/{token_id}` — list and revoke.
- `POST /invitations/{token}/accept` — accept. Signed in, it adds the
  membership and switches to it. Signed out, it survives sign-in and is
  applied afterwards.

**Invitations are a table, and a link that grants membership is a credential.**
`id`, `tenant_id`, `role`, `email` (null for a link), `expires_at`,
`uses_remaining`, `revoked_at`, `created_by`, and a hash of the token rather
than the token. Expiry and revocation are not optional; an invitation that
cannot be withdrawn is a permanent grant handed to whoever forwards the mail.

An email invitation is bound to one address and single use, and the address it
was issued to must match the caller's *verified* address — otherwise it is a
link invitation wearing a name.

## 5. Joining by email domain, and the trap in it

`tenants` gains a domain and a flag: anyone whose verified email is at that
domain may join without an invitation.

**The trap: whoever claims a domain first collects everyone who signs up under
it.** A tenant claiming `gmail.com` — or, less obviously, a consultancy
claiming a client's domain — silently absorbs strangers. Three guards, none of
which are optional:

- The domain must match the **verified** email of the person who set it. You
  may claim your own domain, not someone else's.
- A blocklist of public providers, refused outright.
- A domain is claimable by **one** tenant. The second is a 409, not a second
  claim, because two tenants auto-admitting the same domain means the winner
  is whichever query ran first.

Even then, auto-join should *offer* rather than *perform* on first sign-in.
Landing in a workspace nobody told you about, with your name visible to its
members, is a surprise that reads as a bug.

## 6. Listing workspaces without breaking the boundary

`GET /tenants` needs each workspace's name and the caller's role in it — from
`tenants` and `tenant_members`, both of which a bound session can read for
exactly one tenant. The list is inherently cross-tenant; the policy is
inherently not.

**Chosen: get the ids from `tenants_of_user`, then read each tenant's row in a
session bound to that tenant.** One short session per workspace. A person
belongs to a handful, so the cost is a handful of round trips on one screen.

Rejected: **an eighth `SECURITY DEFINER` lookup returning names and roles.**
It is one query instead of several and it is the obvious thing to reach for.
It is also precisely the line `db/tenant_lookup.py` draws around itself — every
existing lookup answers *which tenant*, never *what row*, and the module says
in its own words that this is what makes the exemption worth having. Widening
it to return tenant names and membership roles to an unbound session trades a
documented, closed, tested property for a round trip we do not need. If the
loop ever becomes a real cost, the answer is a cache, not a wider exemption.

## 7. Becoming an administrator

Two different problems wear this name, and only one of them is new.

**A workspace someone creates.** Solved by §4: the creator is its `owner`. No
bootstrap needed, because there was nobody there before them.

**A deployment that already exists.** This is `CHOO-2726`, and it is unsolved
today: just-in-time provisioning always writes `member`, linking an identity to
the seeded local administrator is deliberately refused, and the only remedy is
editing the database. That works on a laptop and is unavailable to anyone
handed a deployed environment.

**Chosen: an operator names the bootstrap administrators in configuration,
before anyone signs in.** A list of email addresses; a verified match at first
sign-in provisions with `owner` in tenant zero instead of `member`. It is
explicit, it is auditable in the deployment's own config, and it cannot be
raced — the operator who can set it already owns the environment.

With, as the ordinary path afterwards, an existing `owner` or `admin` being
able to change another member's role through the API.

Rejected: **first person to sign in becomes an administrator.** It is the
cheapest to build and it hands the environment to whoever finds the URL first.
On a deployment reachable before its operator has signed in — which is every
deployment, briefly — that is not a theoretical race.

## 8. What this does not cover

Per-tenant agent registration credentials, tenant switching in Console, and
the workspace-versus-server vocabulary question are all Phase 2 scope and none
of them are here. The first two want this built before they can be designed
against; the third is a product decision, not a schema one.

## 9. Done when

- One person holds memberships in two workspaces, and a request acts in
  exactly the one they chose — proven by a test that writes in one and cannot
  read it in the other.
- A person with several memberships and no selection gets the list and a 409,
  never a guess.
- An invitation can be minted, accepted once, and revoked before use.
- A domain cannot be claimed by two tenants, nor by someone who cannot prove
  they use it.
- An operator who has never signed in can name themselves an administrator in
  configuration and have it be true on first sign-in.
