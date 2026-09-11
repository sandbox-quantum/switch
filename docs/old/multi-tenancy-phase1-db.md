# Multi-tenancy Phase 1: the database design

Status: partially built. Implements §2 of `multi-tenancy.md` (spike CHOO-2603)
for CHOO-2623.

This document was written as one design covering the whole schema half of
Phase 1 — new tables, per-tenant uniqueness, composite foreign keys, the
row-level-security policies, and the session plumbing that sets the tenant —
and its reasoning below still describes that whole shape. What actually
shipped is narrower: **the tenant model, per-tenant uniqueness and the
composite foreign keys are built**, in the one migration this document
describes. **Row-level security is not**: `require_tenant_id()`, the policy
attached to each table, `db/rls_ddl.py`, and the isolation test under "Done
when" were all split out into a later change, along with everything in
"Setting the tenant" and "The bootstrap problem" below — the `tenant_session`
/ `system_session` seam, the 107-call-site and 206-call-site migrations off
the raw session, and the request-side wiring. None of that exists in the
codebase yet. Read the sections below as the design those later changes
implement, not as a description of what is running today; "What Phase 1 does
not close" has been updated to say which gaps are this migration's and which
belong to the deferred work.

Postgres 16 everywhere — local Compose, the chart, and the test containers —
and two things below need at least 15, so that is a floor, not an incidental
detail.

## The rule

Everything follows from one sentence:

> **Every table holding customer data carries a non-null `tenant_id`, carries
> the same isolation policy, and every foreign key between two such tables
> carries `tenant_id` as well.**

Uniformity is the point. A reviewer should be able to open any table and know
without thinking whether it is scoped and what its policy says, because there
is only one kind of scoped table and one policy text.

The rule buys two separate guarantees, and they are worth separating:

- **A query that forgets its filter returns nothing** rather than another
  tenant's rows. That is row-level security.
- **A row cannot reference a parent in another tenant.** That is the composite
  foreign key, and row-level security does not give it — referential integrity
  checks in Postgres deliberately bypass policies, so without it a bug can
  write a message into tenant A pointing at tenant B's room. The row is
  unreadable from either side, but it exists, and cleaning that up later is
  worse than preventing it now.

## New tables

```
tenants
  id          text primary key
  slug        text not null unique
  name        text not null
  created_at  timestamptz not null default now()

tenant_members
  tenant_id   text not null references tenants(id)
  user_id     text not null references users(id)
  role        text not null check (role in ('owner','admin','member'))
  created_at  timestamptz not null default now()
  primary key (tenant_id, user_id)
```

Membership is a row, not a column on the user: a person has one login and may
belong to several tenants. That decision is argued in the spike.

`tenants` deliberately has no `plan`, `status` or `deleted_at`. Phase 3 adds
plans, Phase 5 adds deletion, and a `deleted_at` that nothing honours is worse
than no column — it reads as a guarantee the code does not make.

`role` is a checked string rather than an enum type, matching how `users.role`
is already stored. Phase 2 owns making these roles mean something; Phase 1 only
records them so the migration loses no information.

## Which tables are scoped

**Scoped — 36 tables, each gains `tenant_id text not null references
tenants(id)`:**

`api_keys`, `clients`, `client_rooms`, `agents`, `tools`, `models`, `skills`,
`agent_skills`, `rooms`, `room_agents`, `room_skills`, `room_groups`,
`room_links`, `room_roles`, `role_leases`, `tasks`, `references`,
`reference_types`, `documents`, `room_references`, `room_documents`,
`packages`, `room_packages`, `package_references`, `package_documents`,
`collaboration_bridges`, `server_connectors`, `external_users`,
`external_user_claims`, `agent_sessions`, `agent_runtime_states`,
`bridge_message_map`, `messages`, `message_attachments`, `delivery_cursors`,
`media_blobs`.

Longer than the spike's thirteen, because the spike named top-level entities
and the schema has children hanging off them. The test is mechanical: if a row
would be meaningless to another customer, it is scoped.

Three entries are worth justifying:

- **Junction tables are scoped like everything else.** `room_agents` joins a
  room to an agent; both parents are scoped, and the pair is exactly where a
  cross-tenant reference gets introduced. Its own `tenant_id` plus composite
  keys to both parents makes "an agent from tenant B in a room from tenant A"
  unrepresentable. Inheriting tenancy through a subquery policy instead is
  slower and needs per-table reasoning.
- **`media_blobs` is scoped** although nothing references it by foreign key. It
  holds attachment bytes reached by an opaque URI, and unguessable identifiers
  are not an isolation boundary.
- **`clients` is scoped**, so the admin/system client becomes one row per
  tenant rather than one per deployment. Today that is a no-op — the single
  existing row backfills to tenant zero — and it is the right shape later.

**Global — no `tenant_id`, no policy:** `users`, `oidc_identities`,
`feature_flags`, `alembic_version`.

A user is a person, not a tenant member; the membership row is the per-tenant
object. `oidc_identities` records how that person proves who they are, equally
tenant-independent. `feature_flags` is a deployment switch; a flag that needs
to vary per tenant is a new table, not a nullable column.

Leaving `users` and `oidc_identities` unpoliced has a consequence, and it is
recorded as an open item rather than buried: see "What Phase 1 does not close".

## Uniqueness changes

Adding a column is the easy half. Constraints are what break silently when a
second tenant appears, so the whole list was walked.

**Becomes per-tenant:**

- `agents.name` → `unique (tenant_id, name)`. Two customers can both have a
  `reviewer`. The registration path already treats owner equality as a de facto
  tenant boundary and calls a mismatch a cross-tenant takeover; this makes it
  real.
- `clients.matrix_user_id` → `unique (tenant_id, matrix_user_id)`, required by
  per-tenant system clients.
- `rooms.matrix_room_id` → `unique (tenant_id, matrix_room_id)`.
- `reference_types` primary key → `(tenant_id, type)`. Customer-defined type
  slugs collide. This table has no `id` column at all, so it is the one scoped
  table that cannot carry a `unique (id, tenant_id)` — harmless, because
  nothing references it by foreign key.
- `collaboration_bridges` default-bridge index → `unique (tenant_id) where
  is_default`. "One default bridge for the deployment" is exactly the global
  singleton that breaks on the second tenant.

**Stays global, deliberately:**

- `users.email`. A person is one account across tenants.
- `api_keys.key_hash`. Bearer authentication resolves the hash *before* it
  knows a tenant. Load-bearing — see the bootstrap section.
- `oidc_identities (iss, sub)`. The issuer already namespaces it.
- `media_blobs.uri`, `messages.transport_event_id`. Random globally-unique
  identifiers; scoping them buys nothing.

**Already scoped transitively, left alone:** `messages (room_id, seq)`,
`documents (room_id, name)`, `room_roles (room_id, name)`,
`delivery_cursors (agent_id, room_id)`, `agent_sessions`,
`agent_runtime_states`, `external_users (bridge_id, external_user_id)`,
`bridge_message_map`, `rooms (bridge_id, external_channel_id)`,
`agents.client_id`. Each is unique within a parent that is itself scoped, and
the composite foreign key keeps the parent honest.

`role_leases` is unique on `agent_id` alone across all rooms by design — an
agent has one session and one lease — and an agent implies a tenant, so no
change.

## Composite foreign keys

Every foreign key from a scoped table to a scoped table gains `tenant_id`:

```sql
alter table rooms add constraint uq_rooms_id_tenant unique (id, tenant_id);

alter table messages
  add constraint fk_messages_room
  foreign key (tenant_id, room_id) references rooms (tenant_id, id);
```

Only tables that are actually referenced need the extra `unique (id,
tenant_id)` — about thirteen, not one per scoped table. Foreign keys to
*global* tables (`rooms.owner_id → users.id` and friends) stay single-column.

Two mechanical details decide whether this works at all:

- **Nullable parents keep Postgres's default `MATCH SIMPLE`**, under which a
  NULL in any column skips the check entirely. That is what we want: no parent,
  nothing to verify. `MATCH FULL` would reject a row with a non-null tenant and
  a null parent, which is a legitimate row.
- **`ON DELETE SET NULL` must name its column.** A plain multi-column `SET
  NULL` nulls *every* referencing column, `tenant_id` included, so the delete
  fails on the not-null constraint. Five scoped-to-scoped keys are affected —
  `agents.parent_agent_id`, `rooms.group_id`, `room_groups.parent_group_id`,
  `documents.created_by_agent_id`, `messages.sender_client_id` — and each needs
  the Postgres 15+ form `on delete set null (parent_agent_id)`. Without it,
  deleting a room group or a parent agent is broken from day one. This is the
  single easiest thing to get wrong here.

`ON DELETE CASCADE` needs no such care: it removes the child row entirely.

The cost is every foreign key rewritten and thirteen indexes added. The benefit
is invisible until something goes wrong. The cheaper variant is composite keys
on the junction tables and `messages` only, accepting that everything else
relies on the application writing the right parent id; I recommend against it,
because an inconsistent rule is harder to hold in your head than a uniform one
and the tables left out would be the ones nobody thinks about.

## Row-level security

One function, one policy text, applied identically to all 38 scoped tables (the
36 above plus `tenants` and `tenant_members`).

```sql
create or replace function require_tenant_id() returns text
language plpgsql stable as $$
declare v text := current_setting('app.tenant_id', true);
begin
  if v is null or v = '' then
    raise exception 'app.tenant_id is not set on this session'
      using errcode = '42501';
  end if;
  return v;
end $$;
```

Three cases, one behaviour. Never set in this session returns NULL because of
the `true`; set and then released at commit returns the empty string, not NULL
— the trap that produced a P1 elsewhere in the company; set returns the value.
Both empty cases raise. **The function fails closed, and every other safety
property here rests on that.**

```sql
alter table <t> enable row level security;

create policy tenant_isolation on <t>
  for all
  using       (tenant_id = (select require_tenant_id()))
  with check  (tenant_id = (select require_tenant_id()));
```

- **`with check` is not optional.** `using` filters what you can read; without
  `with check` a write is unconstrained and you can insert a row into another
  tenant that you cannot then read back. Two of the four prior-art bugs are
  this.
- **`(select require_tenant_id())`** rather than a bare call, so the planner
  evaluates it once per query as an InitPlan rather than once per row. Marking
  the function `stable` is not sufficient on its own.
- **No `TO <role>` clause.** An earlier draft named the runtime role; that
  makes the DDL fail wherever the role does not exist yet, including
  `create_all` in tests. The owner-bypass model below already defines exactly
  who is and is not subject to policies, so the clause bought nothing.
- `tenants` uses `id = (select require_tenant_id())`; every other table uses
  `tenant_id`.

## The runtime role, and why it is not in this phase

Today the application connects to Postgres as the superuser in local Compose,
in the chart and in the test containers. **A superuser ignores row-level
security unconditionally** — not "unless forced", unconditionally. Until the
runtime connects as a role that policies apply to, everything in the section
above is inert in a deployed environment.

That work — creating a `switch_app` role in Compose, the chart and the RDS
runbook, granting it, pointing the service at it, and a startup self-check that
refuses to boot if the connection is a superuser or the table owner — **is
tracked separately and is not part of Phase 1.** The shape it should take, so
that whoever picks it up does not have to rediscover it:

- **Add one role, transfer nothing.** The existing role keeps owning the schema
  and keeps running Alembic. Because it owns the tables it bypasses their
  policies, and we deliberately do **not** set `force row level security`, so
  that stays true. No `ALTER TABLE … OWNER TO`, no `REASSIGN OWNED`, nothing to
  go wrong during a cutover.
- **`switch_app` is the runtime role**: not the owner, not a superuser, no
  `BYPASSRLS`, with `alter default privileges` so a later migration cannot ship
  a table it cannot read.
- **The check that matters runs at startup, not in CI.** CI asserts nothing
  about production and this failure mode is silent. A Switch that believes it
  is isolating tenants and is not is worse than one that is down.
- **Cheapest during the RDS cutover** (CHOO-2622), which already creates an
  application role by hand and restores with `--no-owner --no-privileges` — so
  who owns the restored tables is a decision made there either way.

Splitting it is a reasonable call while the deployment has one tenant, because
there is nothing to leak. It is not a follow-up nicety: **it is a prerequisite
for onboarding a second tenant**, and Phase 1 shipping without it means the
policies exist and do not yet bite.

Phase 1 does keep a restricted role **inside the test fixtures**, which is
contained to the test harness and touches no environment. Without it nothing
verifies a single policy, and 38 of them would ship unexercised.

Consequently this design's migration creates no roles and issues no grants.
Both belong to the role work, in one place, rather than half here behind a
conditional that silently does nothing.

## Setting the tenant

```sql
select set_config('app.tenant_id', $1, true)   -- is_local = true
```

Transaction-scoped, released at commit, so it cannot leak to the next request
that borrows the pooled connection. Both remaining prior-art bugs are
session-scoped settings on a pooled connection; this is the fix, and the
fail-closed function is the backstop when it is missed. Issuing it outside an
explicit transaction only warns and does nothing — survivable here only because
a missing tenant raises rather than matching nothing.

**Where the tenant comes from, per principal:**

| Principal | Source |
| --- | --- |
| Gateway user (JWT cookie) | the user's membership row |
| Agent bearer token | `api_keys.tenant_id` |
| Bridge inbound event | the bridge row's tenant |
| Per-room background work | the room's tenant |

Never from a request parameter; no endpoint accepts a tenant id as input.

Phase 1 has one tenant, so membership resolution returns the single row and
raises if there is more than one. Phase 2 adds tenant switching and an
active-tenant claim; that is a change to one function.

**The request seam has to move.** `get_session` is a FastAPI dependency that
resolves *before* the one that authenticates the user, so there is no moment
today where the principal is known and the session is not yet open. Endpoints
therefore stop depending on `get_session` and depend on a `tenant_session` that
composes it with the principal and issues the `set_config`. That is a
mechanical edit at 107 call sites, and it puts the seam in every signature
where a reader can see it. A test asserts no endpoint uses the raw session.

**Background work is not a short list.** There are roughly 206 places that open
a session from the factory directly. They fall into three shapes — acting for a
room, acting for a bridge, acting for the deployment — so they get two named
helpers, `tenant_session(tenant_id)` and `system_session()`, and a test that
the raw factory is not called anywhere else.

**Writes fill the column automatically.** `tenant_id` gets a Python-side
default reading the request's tenant, so ordinary ORM inserts need no change
across roughly 250 store methods, and `with check` catches anything that
disagrees. Two caveats, both real: the default yields nothing in a system
session, so the startup seeding paths must pass tenant zero explicitly; and one
Core `executemany` in the room store needs checking rather than assuming.

The same context value feeds the logging filter, which has had a `tenant_id`
field since before tenants existed and which nothing has ever bound
per-request. That closes half of Phase 0's logging item as a side effect.

## The bootstrap problem, and the two exceptions

Authentication happens before a tenant is known — resolving an API key by hash,
or a JWT subject to its memberships, is unscoped by definition. So:

> **Authentication and tenant resolution run in a system session. Everything
> downstream runs in a tenant session, as the restricted runtime role.**

The same escape hatch covers work that is legitimately cross-tenant: Alembic,
admin and bootstrap seeding at startup, the bridge and connector lifecycle
loops that start every row at boot, and the runtime-state and connection
sweeps. A test pins the set of modules allowed to open one, so a new one is a
deliberate act.

The delivery listener needs no exception: it holds one unpooled connection that
relays NOTIFY payloads and never reads a scoped table. Its consumers do read
per room — so **the notify payload gains `tenant_id`** alongside the room, seq
and id it already carries. Without it a consumer has to make an unscoped read
just to learn which tenant to scope by, which is a circle.

Two exceptions to the uniform rule, in full:

1. **`api_keys.key_hash` stays globally unique**, because authentication
   resolves it before a tenant exists.
2. **System sessions bypass policies by ownership.** This is a fail-open hatch
   inside a fail-closed design and is named as such: nothing stops a pinned
   module reading across tenants once a second one exists. Phase 1 accepts
   that; the pinned list is what keeps it reviewable.

An earlier draft had a third — a membership-based policy on `users` — and it
was wrong. Its `with check` made creating a user impossible: the membership row
cannot exist before the user, and the user cannot be inserted before the
membership. It also would not have held, because `tenant_members` has no
constraint on *which* user id a tenant may add to itself. Both problems are
Phase 2's to solve properly, alongside invitations.

## Where the SQL lives

The repository already has the pattern in the delivery trigger: the DDL lives
in one module, is attached to the tables so `create_all` builds it, and each
migration carries its own frozen verbatim copy so that editing the module never
changes what a past migration means. The policies follow it exactly, in
`db/rls_ddl.py`.

This matters more than it sounds. Tests build their schema from the model
metadata rather than by running migrations, so a policy that existed only in a
migration would be invisible to every test — the isolation test would pass
against a database with no isolation in it.

A `TenantScoped` declarative mixin carries the column, its default and its
registration in the policy list, so adding a table means inheriting from it and
writing the foreign keys. Without the mixin a new table needs seven separate
things remembered; with it, two, and both are checked by tests.

## The migration

One revision:

1. Create `tenants` and `tenant_members`; create `require_tenant_id()`.
2. Insert tenant zero, slug `default`, with a fixed id constant written into
   the migration. Not read from the environment: `TENANT_ID` is config today
   and a later edit to it must not silently desync from the row.
3. Insert a membership for every existing user — `owner` for accounts with the
   global admin role, `member` otherwise.
4. Per scoped table: `add column tenant_id text not null default '<zero>'`,
   then drop the default. Since Postgres 11 that is a metadata-only operation
   for *this one statement* — no table rewrite, unlike the
   add-nullable-then-backfill-then-set-not-null sequence the spike describes,
   which would rewrite `messages` and `media_blobs` (20MB rows) instead of
   just touching the catalog.
5. Add the foreign key to `tenants` and, where the table is referenced, the
   `unique (id, tenant_id)`.
6. Swap the uniqueness constraints listed above.
7. Rewrite each scoped-to-scoped foreign key as composite, `not valid` first
   and `validate constraint` after.

No roles are created and no grants issued — see the role section above.
Row-level security is not part of this migration either: `require_tenant_id()`,
the policies and the isolation test described elsewhere in this document are
deferred to a later change, tracked separately from the schema landed here
(see "Status" at the top of this document).

**On locking.** Alembic wraps a whole revision in one transaction
(`migrations/env.py`, `context.begin_transaction()`), and this migration does
not open an `autocommit_block` to opt out. So every `ACCESS EXCLUSIVE` lock
taken above — including the plain `CREATE UNIQUE INDEX` behind step 5's
`unique (id, tenant_id)` and step 6's uniqueness swaps — is held on its table
for the whole migration, not released until it commits. The `not valid` /
`validate constraint` split in step 7 does not reduce that: both statements
run inside the same transaction, so the exclusive lock from the `not valid`
add is already held by the time `validate constraint` runs its scan, and
holding it is what a single transaction means. The split is retained anyway,
commented at the call site, because it is the shape this migration would need
if it were ever divided into two transactions — seconds without which
dividing it later means rewriting the FK step, not just moving code. The
longest single lock is very likely whichever unique index build takes
longest — plausibly the ones on `messages` and `media_blobs`.

If a rehearsal against a copy of the production database shows this is too
slow to run as one migration, the fix is to move the index builds to `create
unique index concurrently` inside an Alembic `autocommit_block`, each in its
own non-transactional step. That drops the exclusive lock during the (much
slower) concurrent build down to a share lock, at the cost of the migration
no longer being atomic — a partial failure leaves indexes to clean up by hand
rather than a rolled-back transaction. Deliberately not done here: there are
no measurements yet showing it is needed, and atomicity is worth keeping
until there are.

Only tenant zero exists when this runs, so the usual expand-then-contract
caution does not apply yet. From the next customer onward it does, and that
note belongs in the migration's docstring.

## Done when

An integration test proves tenant A cannot read tenant B's rows through the
ordinary application paths — connected as a restricted role, through the store
layer, not by hand-written SQL. That needs test infrastructure that does not
exist yet: the fixtures create the role, grant to it, connect as it, and seed
tenant zero, because the truncation between tests now empties `tenants` too.

Note what this does and does not prove. It proves the **policies** are correct,
which is the part Phase 1 owns. It does not prove the **deployment** is subject
to them — that is the role work, and until it lands the same test against a
real environment would pass for the wrong reason.

Alongside it, three cheap tests that catch the regressions this design exists
to prevent:

- Every scoped table has row-level security enabled and a policy, asserted by
  querying `pg_policies` and `pg_tables` rather than by reading the code.
- Every foreign key between two scoped tables includes `tenant_id`, asserted
  the same way from the catalogue. Without this a new table passes every other
  check while quietly falling back to a single-column key.
- A query issued with no tenant set raises rather than returning nothing.

## What Phase 1 does not close

Named so they are decisions rather than omissions.

- **No row-level security yet.** The migration that landed adds the tenant
  model, per-tenant uniqueness and the composite foreign keys, and stops
  there — `require_tenant_id()`, the policy, and the runtime-role work that
  would make a policy bite are a later change, not merely inert code sitting
  next to this one. Deliberate, and safe while one tenant exists — and the
  hard prerequisite for the second.
- **Cross-tenant user enumeration.** `users` and `oidc_identities` have no
  policy, so any tenant session can read every account. There is no exposure
  while one tenant exists, and the correct fix needs invitations and a
  per-tenant user list, which is Phase 2's scope. It must not ship without it.
- **`tenant_members` self-service.** A tenant session can insert a membership
  row naming any user id. Same owner, same phase.
- **`users.email` is globally unique**, so signing up with an address that
  exists in another tenant fails on the index rather than being handled — an
  existence oracle and a bad error. Phase 2.
- **System sessions can read across tenants** by design, as above.
- **No indexes on `tenant_id`.** With one tenant the column has no selectivity
  and an index is pure write cost. Add them when the second tenant lands, in
  one migration, `concurrently`, with data to measure against.
- **Two references bypass the composite-key guarantee entirely, by being
  plain strings rather than foreign keys.** `message_attachments.uri`
  references `media_blobs.uri`, and `Reference.type` references
  `reference_types.type`, and neither carries a `tenant_id` or a constraint of
  any kind — so a row can be made to name another tenant's blob or reference
  type, and nothing in this schema stops it. Row-level security closes this
  once a session is tenant-scoped, because the lookup itself becomes
  tenant-filtered rather than because the reference is checked; it does not
  need a foreign key to be safe, but it is unsafe until that lands.
- **Roughly ten read paths call `scalar_one_or_none()` on a column that is
  now unique per tenant rather than globally**, so they raise
  `MultipleResultsFound` the moment a second tenant has a row that also
  matches — `agent_store.get_by_name`, `collaboration_bridge_store.get_default`,
  `client_store.get_by_matrix_user_id`, and `room_store.get_by_matrix_room_id`
  are four of them. They are correct today, with one tenant, and wrong the
  day a second one exists; making the session tenant-scoped, in the next PR,
  is what makes them correct rather than each needing its own fix.
- No plan, status or soft-delete on `tenants`; no tenant deletion; no
  per-tenant feature flags; no tenant switching.
- No per-tenant agent registration credential — Phase 2 owns it as a security
  item, not a refactor.
- No renaming of the residual `matrix_*` columns. Worth doing while these
  tables are open, but not in the migration that changes isolation.
- The room advisory lock hashes only the room id, so it is a cluster-global
  namespace shared across tenants. Harmless at today's scale, worth a note.
