# Multi-tenancy Phase 1: the database design

Status: built. Implements §2 of `multi-tenancy.md` (spike CHOO-2603) for
CHOO-2623.

This document was written as one design covering the whole schema half of
Phase 1 — new tables, per-tenant uniqueness, composite foreign keys, the
row-level-security policies, and the session plumbing that sets the tenant —
and its reasoning below still describes that whole shape, in four changes
rather than one. **The tenant model, per-tenant uniqueness and the composite
foreign keys** landed first, in the migration `8b276792ee30`.
**"Setting the tenant" has since been built** and that section now describes
what was actually implemented, which differs from what it originally proposed —
an event hook rather than a dependency at every call site, for reasons given
there. **The background half of it has since been built too** — the roughly
157 session sites outside the request path now bind a tenant at each unit of
work, described where "Setting the tenant" talks about background work below.
That section also records the model that was tried first, of binding once per
long-lived task, and the four ways it leaked; it is written up rather than
deleted because the reasoning that made it look right is easy to arrive at
twice. **Row-level security has since been built too**: `require_tenant_id()`,
the policy attached to each table, `db/rls_ddl.py` and the isolation test
under "Done when" are all in place, in the migration `265ed188ad6f`.
**And the runtime role has since been built** — the deployment now connects as
a role the policies apply to, which is what makes any of the above bite. That
work is what forced the rewrite of "The bootstrap problem" below: the model
that section described did not survive contact with a restricted role, and the
one that replaced it is `db/tenant_lookup.py`. Read the remaining sections as a
description of what is running today, except where a section says otherwise;
"What Phase 1 does not close" says which gaps remain deliberately open.

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
  tenant rather than one per deployment. The single existing row backfills to
  tenant zero, and `ClientLifecycleService.ensure_system_client` — the
  startup call that guarantees the admin client exists — enumerates tenants
  and creates the missing row in each, rather than asking whether one exists
  anywhere. The distinction has teeth: "one exists" is true for a deployment
  whose second tenant has no admin client in any of its rooms.

  One row per tenant means the *running* registry holds one per tenant too,
  so `ClientLifecycleService.get_by_type` takes a tenant and there is no way
  left to ask it for "the admin client". Every caller has a room in hand and
  so has a tenant to ask with. Not tidiness: `client_rooms` carries a
  composite foreign key on `(tenant_id, client_id)`, so offering one tenant's
  admin client to another's room raises `ForeignKeyViolationError` — and the
  caller that did it, `reconcile_room_clients`, runs inline at startup, where
  an exception is a deployment that does not boot, for anyone.

**Global — no `tenant_id`, no policy:** `users`, `oidc_identities`,
`feature_flags`, `alembic_version`.

A user is a person, not a tenant member; the membership row is the per-tenant
object. `oidc_identities` records how that person proves who they are, equally
tenant-independent. `feature_flags` is a deployment switch; a flag that needs
to vary per tenant is a new table, not a nullable column.

**This is the list that is written down, and the scoped list is the one that
is derived** — that way round, deliberately. The three in the model metadata
are hardcoded in `db/rls_ddl.py`'s `GLOBAL_TABLES` (`alembic_version` needs no
entry; Alembic owns it and never registers it there), and **every other table
in the metadata is scoped by definition**: it must carry the tenant, must have
a policy, and must carry `tenant_id` on its foreign keys to other scoped
tables. A table that is neither in that list nor actually carrying a tenant
raises `UnscopedTableError` from `scoped_tables()`, which runs at the bottom
of `db/models.py` — so the process does not start.

Stated the other way round it fails open, and it was written that way round
first: deriving "scoped" as *has a `tenant_id` foreign key* means a new table
full of customer data and no tenant column is simply not in the set, so
nothing attaches a policy to it, nothing checks its foreign keys, and every
catalogue test passes. That is the regression these tests exist to prevent,
passing. Widening `GLOBAL_TABLES` is the intended escape hatch and stays
available — it just has to be argued for in a diff, because
`tests/switch_core/db/test_tenant_schema_catalogue.py` pins the contents of
the list as well as the rule.

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
  nothing references it by foreign key. It is also the one store that has to
  name the tenant in every method rather than leaving the filter to the
  policy: `session.get` on a composite primary key cannot address a row
  without it. That is why `ReferenceTypeStore` reads and writes both say
  `require_tenant_id()` explicitly. They said `TENANT_ZERO_ID` until the
  policies landed, which under enforcement gave a second tenant a bare 500 on
  create and silence on read, and as owner leaked every tenant's type slugs
  and instructions to every other.
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
  if v is null or btrim(v) = '' then
    raise exception 'app.tenant_id is not set on this session'
      using errcode = '42501';
  end if;
  return v;
end $$;
```

Four cases, one behaviour. Never set in this session returns NULL because of
the `true`; set and then released at commit returns the empty string, not NULL
— the trap that produced a P1 elsewhere in the company; whitespace is neither
of those and names no tenant that can exist; set returns the value. The first
three raise. **The function fails closed, and every other safety property here
rests on that.**

The `btrim` decides but does not repair: the value is returned as it was
given. Trimming it on the way out would be the function deciding, on a
caller's behalf, that a malformed tenant id meant a real tenant. Without the
`btrim` at all, `set_config('app.tenant_id', '   ')` passes and what follows
is a session whose every read comes back empty and whose every write matches
nothing, with no error anywhere to say why.

```sql
alter table <t> enable row level security;

create policy tenant_isolation on <t>
  for all
  using       (tenant_id = (select require_tenant_id()))
  with check  (tenant_id = (select require_tenant_id()));
```

- **`with check` is not optional, and it is load-bearing for updates too.**
  `using` filters what you can read; without `with check` a write is
  unconstrained and you can insert a row into another tenant that you cannot
  then read back. Two of the four prior-art bugs are this. It is tempting to
  think `update` is covered anyway, because Postgres re-checks the updated
  row against `using` — but it only does that when the statement needs
  `select` rights, which is to say when it carries a `where` or a
  `returning` clause. `update t set tenant_id = 'B'` carries neither, and
  under a `with check (true)` it succeeds and moves every row the caller can
  see into another tenant. Verified on 16, after this document twice claimed
  otherwise; both shapes are pinned in
  `tests/switch_core/db/test_row_level_security.py` so the weaker claim
  cannot come back a third time.
- **`(select require_tenant_id())`** rather than a bare call, so the planner
  evaluates it once per query as an InitPlan rather than once per row. Marking
  the function `stable` is not sufficient on its own.
- **No `TO <role>` clause.** An earlier draft named the runtime role; that
  makes the DDL fail wherever the role does not exist yet, including
  `create_all` in tests. The owner-bypass model below already defines exactly
  who is and is not subject to policies, so the clause bought nothing.
- `tenants` uses `id = (select require_tenant_id())`; every other table uses
  `tenant_id`.

## The runtime role

Everything above is inert against a superuser or a table owner. Postgres
exempts the first unconditionally — not "unless forced", unconditionally — and
the second unless `force row level security` is set, which this design
deliberately never sets. So a deployment that installs 38 policies and then
connects as the owner has none of them, and until this landed every
environment did exactly that.

Two roles now, and nothing is transferred between them:

- **The owner** keeps owning the schema. It runs Alembic and nothing else. It
  is configured separately, as `DB_OWNER_USER` / `DB_OWNER_PASSWORD`, and it
  never serves a request.
- **`switch_app` is the runtime role**, and `DB_USER` now means that: a plain
  `LOGIN` role, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, owning
  nothing and able to create nothing. Every request runs on it.

No `ALTER TABLE … OWNER TO`, no `REASSIGN OWNED`, nothing to go wrong during a
cutover: the change to an existing deployment is to create one role and point
`DB_USER` at it.

**Grants are re-issued at boot, by the owner, immediately after the
migration.** `db/runtime_role.grant_runtime_role` gives the runtime role
`USAGE` on the schema, CRUD on every table, `USAGE, SELECT` on every sequence
and `EXECUTE` on every function, plus the matching `alter default privileges`.
Doing it at boot rather than once by hand is what keeps it from falling behind
the schema: a table added by a migration is granted on the same boot that
added it, with no runbook step to forget. It is idempotent and costs one round
trip. `ALTER DEFAULT PRIVILEGES` alone would not do — it is per-granting-role
and silently covers nothing for objects some other role creates — so it is
belt to the braces rather than the mechanism.

**The same function grants the test fixture.** `rls_harness`
(`tests/conftest.py`) creates its throwaway role and then calls
`grant_runtime_role`, rather than listing grants of its own. A fixture that
granted more than production does would let a test pass on a privilege the
deployment has not got; one that granted less would fail for a reason the
deployment never hits.

**The check that matters runs at startup, not in CI.** CI has no production
connection, and this failure mode is silent: a Switch that believes it is
isolating tenants and is not looks exactly like one that is.
`db/runtime_role.verify_restricted_role` runs before the server listens and
before anything writes a row, in increasing order of how much they prove:

1. the role is not a superuser and carries no `BYPASSRLS`, nor is it a member
   of a role that has either — membership is a `SET ROLE` away from both;
2. it neither owns, nor has the privileges of the owner of, any table carrying
   a policy;
3. no table sets `force row level security` — see the bootstrap section for
   why that would be catastrophic rather than stricter;
4. every scoped table still has row-level security enabled and still has its
   policy, taken from `rls_ddl.scoped_tables` so it cannot drift from what the
   schema is supposed to have;
5. every tenant lookup exists, this role may execute it, and calling one
   actually answers — a role that could not would authenticate nobody;
6. **a read of `tenants` with nothing bound raises** — the only one that
   observes behaviour rather than inferring it from the catalogue, and so the
   only one that would catch an exemption the others did not think to look
   for.

Three details are load-bearing and each was got wrong first, which is why they
are written down rather than left to the code.

The second check asks `pg_has_role(current_user, c.relowner, 'USAGE')` rather
than comparing the owner's name to `current_user`, because that is the test
Postgres itself applies: `check_enable_rls` asks `has_privs_of_role`, so a role
granted membership in the owner with `INHERIT` bypasses every policy while
being a different role entirely. Comparing identities called such a connection
clean. Measured, not reasoned.

The fourth exists because every other check is about the *connection*, and all
of them pass on a schema somebody has quietly disarmed: `ALTER TABLE messages
DISABLE ROW LEVEL SECURITY` leaves the role restricted, owning nothing,
forcing nothing — and leaves `messages` readable by every tenant. The
behavioural probe would not catch it either, since it asks only `tenants`.

The last insists on SQLSTATE 42501 **and** on the message `app.tenant_id is
not set`, because 42501 is `insufficient_privilege` and `permission denied for
table tenants` carries it too — a role that had never been granted anything
would otherwise satisfy the probe by failing for an unrelated reason. And it
is asked of `tenants` rather than of any other scoped table because **the
check is only meaningful against a populated table**: Postgres does not
evaluate a policy for a scan that yields no rows, so an empty table answers
"no error" whether or not the connection is exempt. `tenants` is the one
scoped table guaranteed to hold a row, since the same migration that creates
it inserts tenant zero. An empty one is refused rather than passed.

`DB_REQUIRE_RESTRICTED_ROLE=false` turns the whole check into an `error` log,
for a deployment that has not created its role yet. Nothing turns it into
silence.

**Migrations still run at boot, on a different connection.** That was the one
real trade-off here. A restricted role cannot create a table, so something had
to give: either migrations move out of boot — a deployment-ordering change for
every environment — or the runtime role gets schema rights, which hands back
the ownership exemption the policies depend on it not having. Neither is
acceptable, so the connection moved instead of the step. `migrations/env.py`
points Alembic at `DB_OWNER_USER` where one is configured and at `DB_USER`
where none is, which keeps `alembic` on the command line working against a
developer's scratch database and fails loudly and immediately for a deployment
that has moved to a restricted role without saying who its owner is. The order
at boot is: migrate as the owner, grant as the owner, self-check as the
runtime role, then serve.

The residual cost is stated rather than hidden: the process holds a credential
that can run DDL. It is used for two statements at boot and never again, on an
engine that is disposed before the runtime engine is built, and a deployment
that runs its migrations elsewhere can simply not configure it. It is not
nothing, and the alternative was worse.

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

**The set is issued by an event, not by a call.** This paragraph originally
proposed replacing `get_session` with a `tenant_session` dependency at all 107
endpoint call sites. What was built instead is a SQLAlchemy `after_begin` hook,
registered at import, that reads the bound tenant and issues the `set_config`
whenever a transaction opens.

The hook is better for the reason the whole design exists: a dependency each
endpoint must remember to use is a rule, and a rule gets forgotten. A call site
that forgot is one of the four prior-art bugs. With the hook there is no site
to forget, and no endpoint signature changed.

It also turned out the call sites did not need to move at all. Constructing a
session does no I/O — the transaction begins on the first query, inside the
endpoint body, by which point every dependency including authentication has
resolved. That reasoning is load-bearing, so it is pinned by a test asserting
every route reaching `get_session` also reaches an authenticating dependency.

Its real boundary, stated rather than overclaimed: no ORM session in this
process can skip setting the tenant. Two things are not ORM sessions and do
bypass it — the notify listener's raw asyncpg connection, which reads no scoped
table, and Alembic's bare connection, which is deliberately global.

**Resolution runs before the tenant exists, and so cannot run on a session.**
Answering "which tenant does this caller belong to" is by definition the
question a scoped session cannot ask, and `tenant_members` is scoped like
everything else — so it goes through `tenants_of_user`, one of the seven
exempt lookups, which opens a short session of its own with nothing bound.
The `users` existence check beside it is an ordinary unbound read, because
`users` carries no tenant and no policy.

Short-lived on purpose. An earlier attempt held a second session open for the
whole request; that both halved the connection pool and, because the `User` it
returned belonged to a session nobody committed, silently discarded a password
change. Resolution needs the subject id, not a `User` row — so it looks up only
the membership, and the user is loaded from the session the endpoint commits.

**Background work is not a short list, and it has since been closed.** There
are 157 places that open a session from the factory directly, with no request
behind them (174 in all, across nineteen modules, once the request path's own
seventeen are counted). One rule covers all of them:

> **Nothing is ambient. Every unit of background work binds the tenant of the
> row it is acting on, at the point it acts. Long-lived tasks bind nothing for
> their lifetime. A lookup that must span tenants uses a helper that genuinely
> unbinds.**

**The first attempt at this had a different rule, and it was wrong.** It said a
long-lived task "acts for exactly one bridge, so it can bind once for the
task's lifetime", and leaned on an `asyncio.Task` snapshotting the contextvars
of whoever created it. Four things went wrong, and they are one thing:

- **Who creates the task is not who owns it.** A bridge is started at boot,
  with nothing bound, *and* from an HTTP request that edited its connection
  (`gateway/collaborations.py` calls `restart`), with the requesting
  operator's tenant bound. Bind-at-creation makes the bridge spend its entire
  life acting as whoever last restarted it.
- **A long-lived object is not a single-tenant actor.** A client's transport
  reads which rooms it is in — a lookup keyed by a globally unique client id —
  and then works one room at a time. A puppet minted for one person on a
  bridge is reused for every room they ever speak in. A boot-time tenant on
  either is a value that happens to be right until it is not, with no error
  when it turns.
- **A cache that is only filled at startup is empty for everything created
  after startup.** The bridge's room→tenant map was loaded at boot and not
  written by `add_room_mapping`, so every room created later missed it and
  fell back to a database read under whatever was ambient — which on the
  inbound path is the very thing being asked.
- **Not every task inherits anything.** Mattermost's websocket runs on an OS
  thread and dispatches with `asyncio.run_coroutine_threadsafe`, which starts
  the coroutine in an *empty* context. Under bind-at-creation, an auto-created
  room landed in tenant zero on Mattermost and in the bridge's tenant
  everywhere else — the platform decided the tenant. Binding at the inbound
  choke point instead makes the platform irrelevant, which is the property
  worth having.

So what is built now is:

- **Long-lived tasks unbind first.** Every task in the process that outlives
  the call that created it enters `tenant_context.no_tenant()` as its first
  act: `CollaborationBridgeLifecycleService._run_bridge`,
  `ClientLifecycleService._run_client`, `BridgeCore._run_agent_identities`,
  `ConnectorCore._poll_loop`, `PostgresTransport._deliver_forever` and
  `main._runtime_state_sweep_loop`. Nothing inside them can read a tenant it
  did not derive, and once the policies land, a unit of work that forgot to
  bind reads nothing rather than reading someone else's rows. Three of those
  six are created from a context that binds nothing anyway, so entering it
  changes no behaviour there — that is the point. Being correct because of
  where you were created is the dependency this rule exists to remove, so it
  is not left standing where it happens to be harmless. (`main.
  _connection_sweep_loop` is the one long-lived task that does not, because it
  expires in-memory `Connection` objects and opens no session at all.)
- **Each unit of work binds the row it is acting on.** A delivery binds the
  room's tenant (`transport/postgres.py`); an inbound platform event binds the
  room's, or — when the handler is about to auto-create the room — the
  bridge's, at the single choke point every handler passes through
  (`BridgeCore._traced`); a membership change binds the room's
  (`room_service.py`); a sweep row binds its own, for the *whole* of that
  row's work including the event emitted at the end
  (`ProtocolService.sweep_runtime_states`); one poll and the events it
  returns bind the connector's (`server_connectors/core.py`).
- **An object may know its tenant without binding it.** `BridgeCore` holds
  `bridge_tenant_id` and `ConnectorCore` holds `connector_tenant_id`, read
  once from the row they are the runtime for. Knowing is not binding: the
  value is bound around a piece of work and released, never held open. Rooms
  cannot disagree with their bridge in any case — `rooms` carries a composite
  foreign key to `collaboration_bridges` on `tenant_id` — but room-scoped work
  still binds the room's own tenant rather than relying on that.
- **The lookups that produce a tenant do not consume one.** Which room is this
  transport id? Which rooms is this client in? Which agent is this client?
  Which tenant is this bridge in? Each is asked before the answer is known, so
  binding one first is either a tautology or, under policies, a false "not
  found". Each is now one of the seven exempt lookups in `db/tenant_lookup.py`
  — see the bootstrap section, which is where that whole model is argued.

**One named helper carries this**: `tenant_session` (`db/session_scope.py`)
binds a tenant and opens a session, in that order. There was a second,
`unscoped_session`, which unbound for the duration of a block; it is gone, for
reasons the bootstrap section gives at length. The order in `tenant_session`
is not cosmetic: the `set_config` rides `after_begin`, so binding *after* a
session's transaction has opened changes nothing the database can see.

`tests/switch_core/db/test_tenant_exemption_allowlist.py` pins two lists, both
derived from the source tree rather than from imports. The first is which
modules may reach the exemption at all — matched on the import rather than the
call, so `import … as` cannot walk past it. The second is the one that matters
more day to day: **which modules may open a session straight from the factory.**
A raw call inherits whatever is ambient, which in background code is now
nothing. (It cannot be matched the same way: every service is handed its own
factory, so there is no single definition to resolve. It keys on a name ending
in `session_factory`, which is over-eager rather than under-eager — the safe
direction for an audit — with the two accessors that hand a factory back
named as exceptions.) Those call sites across nineteen modules are the
inventory this design has to work down; pinning the module list makes a new
one a decision rather than a default.

**Cost, stated rather than hidden.** The hook adds one `SELECT set_config(…)`
round trip per transaction, which on the delivery path is roughly per message
once a handler writes. Measured against the test container (Postgres 16 over
a colima socket, 400 single-statement transactions per arm, two runs): mean
0.95–1.20 ms unbound against 1.30–1.41 ms bound, a delta of **0.20–0.36 ms per
transaction**. That environment's round trip is slower than a deployed one's,
so read it as an upper bound on the shape rather than a production figure —
but it is one extra round trip per transaction, and on a chatty room that is
one extra round trip per message. If it ever matters, the fix is to widen the
unit of work rather than to skip the hook: fewer, larger transactions pay it
fewer times, and skipping it is how the prior-art bugs happened.

**Writes fill the column automatically.** `tenant_id` gets a Python-side
default reading the request's tenant, so ordinary ORM inserts need no change
across roughly 250 store methods, and `with check` catches anything that
disagrees. One Core `executemany` in the room store needed checking rather
than assuming.

**What the default does when nothing is bound changed with the policies.** It
used to answer tenant zero. `db/models.py`'s `require_tenant_id` now raises
`TenantNotBoundError` instead, in Python, before the row reaches the
database — so the failure names the write that forgot to bind rather than
whatever error Postgres would have raised later, and it fails on the owner
connection every environment still uses, where no policy bites at all. The
fallback was defensible while a missing tenant merely meant "the only tenant
we have"; under `with check` it is a write into a real customer's data that
the database cannot tell apart from one tenant zero intended.

Three consequences worth naming, because they are the whole cost of removing
it:

- **Startup names its tenant.** Seeding the admin user, and provisioning the
  admin client, run before any request has bound anything. They say tenant
  zero, or the tenant of the row they are creating, rather than letting a
  default say it for them — the same shape `gateway/oidc_routes.py` already
  used for a just-in-time provisioned account.
- **`tenant_members` is the one scoped write the default cannot cover**,
  because the caller supplies its whole primary key. `UserStore` therefore
  called `current_tenant_id() or TENANT_ZERO_ID` by hand: a private copy of
  exactly the fallback being removed, and the thing keeping admin seeding
  alive. It now calls `require_tenant_id` like everything else, and the
  seeding paths bind.
- **The test fixtures bind tenant zero by default.** Most of the suite
  constructs scoped rows directly rather than through a request, so without
  it they would be exercising a path the design does not have. A test that
  is *about* what is bound opts out with the `no_ambient_tenant` marker.
  Applying that marker suite-wide turns 354 tests red, which is the expected
  shape rather than a finding.

### An account with no membership, and how it gets one back

Resolution refuses to guess (above), so an account with no `tenant_members`
row cannot sign in on any route — 403, permanently, not degraded. The
migration gave one to every account that existed when it ran, and
`UserStore.create` has written one on every path that makes a user since. But
a deployment tracking this work applied the migration several commits before
`create` learned to, so anything created in that window has none; so does an
account whose membership is later removed.

Nothing repaired that except an OIDC login (`UserStore._link_identity`, now
`ensure_membership`). A password account had no remedy inside the product at
all — no endpoint writes a membership, and every endpoint that could is behind
the 403 — which left `INSERT INTO tenant_members` on the box.

Startup seeding is the repair: `_seed_admin_user` already looks the configured
admin up by email on every boot, so it calls `ensure_membership` on the
existing-admin branch instead of returning. Idempotent, and it logs at
`warning` only when it actually wrote one, because an account that could not
sign in until this boot is not routine news. That fixes the deployment's own
admin, which is enough to get an operator back in; anyone else they can then
repair from the UI.

`TenantMemberStore` grew no `create` to go with it — it had one, unused, and
it is gone. "Exactly one membership per account" holds because a single
idempotent function writes them all, and a second unguarded way in, taking
`tenant_id`, `user_id` and `role` from whatever the caller felt like, is how
an account ends up with two. Resolution rejects two as firmly as none.

### The log has to name the tenant the transaction writes

The logging filter has carried a `tenant_id` field since before tenants
existed. It read the *log* context, which `gateway/auth.py` and
`bridges/agent/auth.py` bind per request — and nothing else. Background work
binds its tenant through `tenant_context`, which is the binding
`db/tenant_session.py` turns into `set_config('app.tenant_id')`, so the
startup seeding wrote rows into `00000000-…` while logging
`tenant_id=default`. Not a longer spelling of the same thing: a different
tenant, and one that appears in no table.

`LogContextFilter` now reads three sources in order — the request's binding,
then `current_tenant_id()`, then the configured placeholder. `TENANT_ID` stays
what it was and is documented as a placeholder rather than a tenant id: it
only applies where neither binding exists, which is also where nothing scoped
can be written, so it contradicts no row. Setting it to a real tenant's id
would be worse than leaving it — every unattributed line in the deployment
would then be indistinguishable from that tenant's own under a `tenant_id`
filter.

## The bootstrap problem, and the exemption that answers it

Authentication happens before a tenant is known — resolving an API key by
hash, or a JWT subject to its memberships, is unscoped by definition. This
section used to say:

> ~~Authentication and tenant resolution run in a system session. Everything
> downstream runs in a tenant session, as the restricted runtime role.~~

**That does not work, and the reason it does not is the whole of what follows.**
`require_tenant_id()` raises when no tenant is bound. An "unscoped session" is
a session with no tenant bound. So unscoped is not a hatch out of the
policies; it is precisely the state they refuse. The model looked complete
only because every environment connected as the tables' owner, whom Postgres
exempts — the hatch was ownership all along, and the helper called
`unscoped_session` was a name for something the connection was doing anyway.

Standing a real deployment up under a restricted role found nineteen sites
that depended on it — seventeen of them `unscoped_session`'s own call sites,
and two more raw-session credential reads that leaned on the same ownership
exemption without ever calling that helper — in four groups:

- **Six fatal at startup**, before the process ever listened. The first was
  the agent-registration bootstrap seeding; then the tenant enumeration for
  built-in shadowing, `ensure_system_client`, `ClientLifecycleService.
  start_all`, the collaboration-bridge lifecycle, and
  `reconcile_room_clients`.
- **One silent.** The server-side connector lifecycle is started by a bare
  `create_task`, so when its read began returning nothing, no connector
  started and nothing said so at any log level.
- **One on a timer**, logging the same failure every five seconds: the
  runtime-state sweep.
- **Three per request** — the bearer-token lookup, the gateway's membership
  resolution, and the OIDC client-id lookup — plus eight more reached once
  startup was unblocked.

Two findings from that exercise constrain any fix, and both were measured
rather than reasoned:

- **Fail-closed is data-dependent.** `require_tenant_id()` only raises if
  Postgres evaluates the policy, and it does not for a scan that yields no
  rows. Two of the nineteen were invisible until a row existed. Every test
  asserting an exemption works therefore runs against a populated table, and
  so does the boot self-check.
- **Binding tenant zero as a default is not viable.** It was tried. Tenant one
  worked end to end and tenant two was locked out entirely — membership
  invisible, API keys invisible, agents never started. Credential resolution
  is genuinely cross-tenant.

### What replaced it

> **The whole exemption is seven `SECURITY DEFINER` functions that answer
> *which tenant*, and never return a row.**

They live in `db/tenant_lookup.py`, are owned by the schema owner (so they run
outside the policies), and each returns `setof text`:

| function | answers |
| --- | --- |
| `all_tenant_ids()` | every tenant in the deployment |
| `tenants_of_user(user_id)` | a login's memberships |
| `tenant_of_api_key(key_hash)` | a bearer credential's tenant |
| `tenant_of_agent_oauth_client(id)` | an OIDC agent's tenant |
| `tenant_of_room(room_id)` | a room's tenant |
| `tenant_of_collaboration_bridge(id)` | a bridge's tenant |
| `tenant_of_server_connector(id)` | a connector's tenant |

There were eight. `tenant_of_client(client_id)` is gone, and how it went is
the standard to hold a new one to: both of its callers — a client's transport
and an agent client's startup — already held the `clients` row the answer was
on, and were asking the database to tell them something they could have been
handed. `ClientBase` and `PostgresTransport` now take a required `tenant_id`,
`ClientFactory` reads it off the record, and revision `b1d7c4f0a92e` drops the
function so it is not merely unused but uninstallable-by-accident. It was also
the lookup called most — once per transport — so the round trip goes too.

**It is a closed list**: `TENANT_LOOKUPS` is compared against the functions
actually installed, against the migration's frozen copy (statement text, not
just the inputs to it), and against what each answers when called as the
restricted role. `EXECUTE` on all seven is revoked from `PUBLIC` and granted
to the runtime role by name at every boot (`db/runtime_role.py`), and the boot
self-check refuses to serve if `PUBLIC` ever has it back — so "who may call
them" is the runtime role rather than anyone holding a connection.

### What the exemption actually discloses

The earlier version of this section claimed that **the most a caller can
extract is the tenant of an identifier it already holds**. That is false three
ways, it was repeated in four other places in the tree, and it is worth
replacing with something narrower and true rather than softening.

What holds: every lookup returns `setof text` — tenant ids, never a row of a
scoped table. **No customer data crosses a tenant boundary through this
module, on any function, for any argument.** That is the property worth
having and it is intact.

What the old claim got wrong, all of it about *metadata* rather than rows:

1. **`all_tenant_ids()` takes no identifier.** It enumerates the deployment:
   how many tenants there are and what their ids are. Nothing narrows it to
   what the caller already holds, and nothing can — the boot fan-outs and the
   runtime-state sweep exist precisely to visit tenants the caller has never
   heard of.
2. **`EXECUTE` was left at the `PUBLIC` default** a new function gets, so any
   role with `CONNECT` on the database could call every one of them. Closed,
   as above.
3. **`users` and `oidc_identities` carry no tenant and so no policy** (see
   `GLOBAL_TABLES`) — a person is global, and the per-tenant object is the
   `tenant_members` row. A session with nothing bound may therefore read every
   user id, and feeding those one at a time to `tenants_of_user` reconstructs
   the whole user-to-tenant membership graph. That follows from the schema,
   not from this module, and it is **not** closed — it is the same gap as
   "Cross-tenant user enumeration" under "What Phase 1 does not close", and it
   needs invitations and a per-tenant user list to shut.

So the property this design holds is: **the exemption discloses the shape of
the deployment — which tenants exist, and which tenant a given user,
credential, room, bridge or connector belongs to — and no row of any
tenant-scoped table.** It is a boundary on data, not on metadata. Narrowing
the second is a question about who may hold the runtime role's credentials at
all, since everything above is reachable by anyone who has them.
`test_tenant_lookup.py` pins both halves: the membership graph really is
reconstructible, and the `tenant_members` rows themselves really are refused
to the same session.

The nineteen sites became one of three shapes, and the shape is the
interesting part:

1. **Credential resolution** — bearer token, JWT subject, OIDC client id,
   registration token. Resolve the *tenant* through the exemption, bind it,
   then read the row itself through the ordinary scoped store. No row ever
   arrives from an exempt path.
2. **Cross-tenant enumeration** — the boot passes over every client, bridge,
   connector and room, and the runtime-state sweep. `all_tenant_ids()` and
   then one scoped pass per tenant. These sites already fanned out per row and
   bound that row's tenant; the loop moved one level up, and the read inside it
   is now subject to the policies like every other read.
3. **Per-item work that can derive its tenant** — a client's transport, a
   bridge or connector started by id, a room reached by id. One lookup by the
   globally unique identifier the caller already has, and everything after it
   is scoped.

Each fan-out filters what it reads back on the tenant it bound. That looks
redundant and is not: most store methods here carry no `WHERE tenant_id = …`
of their own and lean on the policy for it, so on a connection Postgres
exempts — the unit suite's, and any deployment still running with
`DB_REQUIRE_RESTRICTED_ROLE=false` — the same read returns every tenant's rows
on every pass and the fan-out acts on each row once per tenant. Silent
duplication is the failure this design refuses to ship, so the filter is
written out rather than inferred from the connection.

**`unscoped_session` is gone**, and with it the last helper that promised
cross-tenant access. `db/session_scope.py` now holds one function. Two things
still open a session with nothing bound, and neither is cross-tenant: the
exemption's own plumbing, which touches only its own functions; and the reads
of `users` and `oidc_identities` in `gateway/auth.py` and `main.py`, which
carry no tenant and no policy, so an unbound session is the honest way to read
them.

### Why not the obvious alternatives

- **Three narrow `SECURITY DEFINER` functions returning rows** was the first
  instinct and does not scale to nineteen sites over nine tables: each would
  be a second copy of a store method written in SQL, with its result mapped
  back by hand, and the exemption's blast radius would widen from "a tenant
  id" to "any row of those tables, to any caller". Returning only the tenant
  is what keeps the surface small enough to read.
- **A second engine connected as the owner, or a `BYPASSRLS` role.** Works,
  and puts a credential that bypasses every policy inside the process for its
  whole life, reachable from anything that can get at the factory. The
  exemption stops being enumerable — it becomes "whatever that engine is used
  for" — which is the property this design most needs to keep. `BYPASSRLS`
  additionally cannot be granted by `rds_superuser`, so the managed cutover
  would have to use the owner anyway.
- **A GUC the policy consults**, e.g. `using (current_setting('app.bypass') =
  'on' or tenant_id = require_tenant_id())`. Ambient by construction — the
  exact property being removed — and settable by the very role it is meant to
  constrain.
- **`force row level security`.** Sounds like more isolation and is less: it
  takes the ownership exemption away from the owner, which is what the seven
  functions run as, so nothing in the process could resolve a credential and
  no request would authenticate. Boot refuses to start if it is ever set, and
  a test asserts no table has it.

### Binding a tenant around a session that is already open does nothing

Worth its own heading, because it is the seam where a mistake is invisible.
The `set_config` rides `after_begin`: it is issued once, when the transaction
opens. Entering a `tenant_scope` *inside* an open transaction rebinds a
contextvar and nothing else — the connection keeps whatever it was told at
begin. Every read after that runs under the original tenant, and a write's
column default takes the *new* one while `with check` compares the *old*, so
the database refuses it outright.

The bootstrap seeding was exactly this shape, and it passed for years because
the owner connection made both halves invisible.
`db/tenant_session.TenantBindingDriftError` now raises on any statement whose
bound tenant disagrees with what its transaction was stamped with, so the
silent no-op is a loud failure everywhere rather than a thing to notice in
review. It hangs off two events, not one: `do_orm_execute` catches every read
and every explicit `Session.execute`, and `before_flush` catches the writes,
which do not go through `Session.execute` at all — the unit of work emits its
`INSERT`s straight to the connection. The flush is the case that matters most,
since a drifted *write* is where the column default and `with check` disagree
about which tenant the row is in, and it was the half the first version of the
guard missed. A savepoint deliberately does not re-stamp: an `is_local`
setting made inside one survives `RELEASE` and reverts on `ROLLBACK TO`, so
recording the savepoint's tenant would leave the record and the connection
disagreeing after a rollback.

Adding the guard found five more instances, all in tests arranging a second
tenant's rows on a session already stamped with the first's.

The fix is never to move the `tenant_scope` up a line or two. It is to open
the session inside the binding, which is what `tenant_session` does and the
only reason it exists.

**One read reaches neither the guard nor the policy, and it needed a check of
its own.** Everything above fires on a round trip: the policy is the server's,
`do_orm_execute` fires on a statement and `before_flush` on a unit of work.
`Session.get` answered from the identity map is none of those — it matches the
primary key against objects the session has already loaded and returns one
with no statement, no transaction and no flush. So a session reused across two
tenants could be handed the first tenant's row back while the second was
bound, silently, on a connection the policies *do* apply to. Measured, not
inferred: on SQLAlchemy 2.0 a second `get` for a key already in the identity
map fires no ORM execute event at all. `db/tenant_session.TenantCheckedSession`
closes it, wired under every session by `db/engine.create_session_factory`,
and it checks the *row* rather than the transaction — the object in hand
carries its own `tenant_id`, which survives a commit clearing the stamp, and
it compares on the same column the policy does (`id` for `tenants`, since a
tenant is the boundary rather than something inside one).

Two things bound the check, and both are load-bearing. It is silent when
nothing is bound, because then there is no tenant to say the row is *not* in.
And it fires **only when the `get` issued no statement**: one that reached
Postgres was filtered by the policy on the way, so refusing it as well would
impose the policy's semantics on the owner connection — which nothing else in
this design does, deliberately, and which is why every fan-out filters its own
results instead. The first version of this check did not make that
distinction and failed four tests that legitimately arrange a second tenant's
fixture rows over an owner connection; that is the false positive the
distinction exists to avoid.

The exposure was narrow, and narrower still than it looks: SQLAlchemy's
identity map holds *weak* references, so the stale object is only reachable
while something else keeps a strong one. That cuts both ways — it makes the
leak rare and it makes it intermittent, dependent on whether a local variable
happens to still be in scope, which is the worst shape for something nobody
would think to test. `tenant_session` opening the session inside the binding
is what keeps any ordinary path from reusing one, but this was the single
place where both mechanisms this design rests on were absent at once, and that
is worth a check rather than an argument.

The delivery listener needs no exception: it holds one unpooled connection that
relays NOTIFY payloads and never reads a scoped table. Its consumer
(`PostgresTransport`) does read per room, but it turned out not to need the
notify payload to carry the tenant: the same lookup that already resolves and
caches a room's internal id from its transport-side id
(`PostgresTransport._resolve_room`) resolves and caches the room's tenant from
the very same row, so there is no *second* unscoped read to avoid — the first
one was already there, for the id. Consumers bind that cached tenant for the
delivery itself and for a send, not only for the row read that first
discovered it, so a handler's own downstream session opens (posting to a
bridge, gating a command) are covered too — they run in the same task, and the
binding is a contextvar, not something tied to one session object.

**The transport's tenant is its client's, derived rather than inherited.**
This paragraph used to say the opposite: that `joined_rooms` must run with
nothing bound, because it runs once and decides what that client will ever
hear, and a tenant over that read returns a subset with no error to say so.
The worry was right and the remedy was not. Under the runtime role, nothing
bound returns *nothing* rather than a subset, which is the same silent
deafness with a shorter list. The tenant now comes from the client's own row,
through `tenant_of_client` — which is the same answer the read itself would
have given, and cannot be a narrowing: `client_rooms` and `messages` both
carry composite foreign keys through `tenant_id`, so a client is neither a
member of nor a sender in any room outside its own tenant. That is pinned in
`tests/switch_core/transport/test_postgres_transport.py`, because the shape of
the room list rests on it.

**Scoping the transport found a cross-tenant bug that predated it**, and it is
worth recording because of the shape rather than the size. `InviteBus` keyed
its handler slot on `matrix_user_id`, process-wide — and `matrix_user_id` is
unique *per tenant*, with `ensure_system_client` deliberately giving every
tenant's admin client the same `@switch-admin:<server>`. Two tenants running an
admin client meant one slot and one winner. An invitation for either woke
whichever had won, and `invite` answered True because *a* handler existed, so
`invite_to_room` took that as "a live client has joined itself" and returned
without writing the membership row — while the woken transport could not
resolve a room in the other tenant and logged an error nobody was looking for.
A tenant's rooms silently had no admin participant.

The bug was there before; what changed is that it used to surface as an
`IntegrityError` on `client_rooms`' composite key, and the scoped resolve turns
that into a swallowed "not a Switch room". The fix is to key on `clients.id`,
a uuid primary key, so there is nothing for a tenant to disambiguate — which
is only possible because the transport now knows which client it is acting for
in the first place. It is the same lesson as the rest of this section: an
identifier that is unique *per tenant* cannot be used as a key in anything
that spans them.

Two exceptions to the uniform rule remain, in full:

1. **`api_keys.key_hash` stays globally unique**, because authentication
   resolves it before a tenant exists. It is the column
   `tenant_of_api_key` reads.
2. **The seven lookups bypass the policies by ownership**, which is what
   `SECURITY DEFINER` buys them. That is a fail-open hatch inside a
   fail-closed design and is named as such — but it is a hatch the width of a
   tenant id, granted to a fixed list of functions, rather than the width of
   a session. The list is the audit surface.

The third exception this section used to carry is gone. **The
agent-registration bootstrap key was seeded on an unbound transaction and
wrote two scoped rows there** — the one place in the tree where "unscoped
session" and "scoped write" met, listed here so the role work would not have
to discover it. It did have to be discovered anyway, because the note
undersold it: the `tenant_scope(TENANT_ZERO_ID)` inside that block was a
no-op, since the transaction was already open (see the heading above). The
seeding is now three phases — the two accounts in tenant zero, the
admin-owned-agent warning over every tenant one at a time, and the key itself
in whichever tenant holds it — and `_bootstrap_key_tenant` enforces "one
bootstrap key per deployment" across tenants rather than within one, which is
where a second one could actually appear.

An earlier draft had one more — a membership-based policy on `users` — and it
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

A `TenantScoped` declarative mixin carries the column and its default, so
adding a table means inheriting from it and writing the foreign keys. Without
the mixin a new table needs seven separate things remembered; with it, two,
and both are checked by tests. There is no third thing to remember —
registering the table in the policy list — because there is no list to
register in: a table is in it unless `GLOBAL_TABLES` says otherwise, and a
table that forgets the mixin does not get skipped, it stops the import.

## The migration

What shipped as one design landed as three revisions: the schema
(`8b276792ee30`) below, row-level security (`265ed188ad6f`, "Where the SQL
lives" above) after it, and the exemption (`9c41a7b0e5d8`) after that.
Splitting them was not the original plan — it fell out of building this in
stages — but it turned out to be the right shape anyway: the schema migration
is safe to run and roll back on its own, with every policy still inert against
the owner connection either way; the second revision is a short, mechanical
follow-on with nothing but `require_tenant_id()` and 38 near-identical `enable
row level security` / `create policy` pairs to review; and the third is eight
`SECURITY DEFINER` functions (a fourth revision later drops one of them), which is the only part of the schema a reviewer
has to think about the privileges of.

None of the three creates a role or issues a grant. The runtime role is
created by the deployment — one `CREATE ROLE` in Compose, the chart's values,
or the RDS runbook — and granted by the application at boot on the owner
connection, right after `alembic upgrade head`, so a table a later revision
adds is granted on the boot that adds it. A migration naming the role would
fail wherever it does not exist yet, including `create_all` in tests, which is
the same reason the policies carry no `to <role>` clause.

The schema revision:

1. Create `tenants` and `tenant_members`.
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

Row-level security is not part of the schema revision: it is the second one,
`265ed188ad6f`, which creates `require_tenant_id()` and every table's policy
and nothing else. The exemption is the third, `9c41a7b0e5d8`, which creates
the eight lookups and nothing else — `b1d7c4f0a92e` is a fourth revision, and
drops `tenant_of_client` once its callers stopped needing it.

`EXECUTE` on a new function defaults to `PUBLIC`, which is what let the third
revision install them without knowing the runtime role's name. That default is
not left in place: it means any role with `CONNECT` on the database can call
them, so `grant_runtime_role` revokes `EXECUTE` from `PUBLIC` and grants it to
the runtime role by name on every boot, and the self-check refuses to serve if
`PUBLIC` gets it back. What a caller who can reach them learns is stated
exactly under "What the exemption actually discloses" above — it is more than
this document used to claim.

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

Built, in `tests/switch_core/db/test_row_level_security.py`. An integration
test proves tenant A cannot read tenant B's rows through the ordinary
application paths — connected as a restricted role, through the store layer
(`RoomGroupStore`), not by hand-written SQL. That needed test infrastructure
which did not exist before this change: `rls_harness`
(`tests/conftest.py`, alongside `session_factory`) creates the role, grants to
it through `grant_runtime_role`, connects as it, and seeds tenant zero against
a schema built the same way `session_factory` builds one.

**The integration suite runs the whole application as that role too.**
`tests/integration/conftest.py` creates `switch_app`, grants it the same way,
wires every service to it, and runs `verify_restricted_role` before the first
test — keeping the owner connection only for building the schema and
truncating between tests, neither of which the application does. That is what
turns the integration suite from a test of the code into a test of the code
*under the policies*, which is what it was not before, and what let nineteen
call sites come to depend on reads a deployed system refuses.

**And the deployment was stood up under one.** Postgres 16 in a container on a
non-default port, `switch_owner` owning the schema and `switch_app` serving,
with `python -m switch_core.main` run end to end: migrations applied as the
owner, grants issued, the self-check passing and saying so, both front doors
authenticating (gateway cookie login and agent bearer token, each refusing an
absent or bogus credential), a room created through the gateway, a message
posted by one agent and delivered to another through the Postgres transport,
and then a second tenant added. With two tenants: boot created exactly one
admin client for the new one and none extra for the old; each tenant's admin
saw only its own rooms and agents; naming the other tenant's room id directly
answered 404 on both the gateway and the agent bridge, in both directions; and
an agent key from one tenant could neither read nor write the other's room,
while the same key worked in its own. Every table involved held rows
throughout, for the reason given above.

Note what each layer proves. The unit tests prove the **policies and the
exemption** are correct against a role they apply to. The integration suite
proves the **application** works as that role. The stand-up proves the
**deployment** does, which is the part no test can assert, because CI has no
production connection — which is why `verify_restricted_role` runs at boot
rather than in CI.

Alongside it, the cheap tests that catch the regressions this design exists
to prevent — in that file unless another is named:

- **Every table in the metadata is scoped unless it is named in
  `rls_ddl.GLOBAL_TABLES`**, and that list is pinned by its own test so
  extending it is a two-place, reviewable change rather than the quick way to
  quieten a red suite (`tests/switch_core/db/test_tenant_schema_catalogue.py`,
  and the same list drives every check below). This is the inverted form
  described under "Which tables are scoped"; the original derivation —
  "scoped" means *carries a `tenant_id` foreign key* — was checked against a
  table added with customer data and no tenant column, and the whole
  catalogue passed.
- Every scoped table has row-level security enabled and a policy whose
  `using` and `with check` both isolate on that table's tenant column,
  asserted by querying `pg_policies` and `pg_tables` rather than by reading
  the code, with the table list itself coming from `rls_ddl.scoped_tables` —
  the same derivation that attached the policies, not a second copy of it,
  which is what let the catalogue and the policies disagree before. The
  predicates are compared by content, not merely for being present: `using
  (true)` is a policy that is enabled, catalogued and isolates nothing.
- The migration's frozen `SCOPED_TABLES` matches that same derivation. A
  frozen copy is the right shape (a migration must not change meaning
  because a model did) and its failure mode is falling behind in silence —
  a table added to the models gets a policy from `create_all`, so every test
  above still passes, while a deployment built by Alembic has none. They
  agree at 38; a deliberate divergence is still expressible, as a new
  migration.
- A write-side trio for what `with check` catches that `using` alone would
  not: an `INSERT` addressed to another tenant, an `UPDATE` moving an own row
  into one, and an **unqualified** `UPDATE` that names no rows. The last is
  the one that matters — see the `with check` bullet above — and the middle
  one is refused by the `using` re-check either way, kept because it is the
  shape application code writes.
- A query issued with no tenant set raises rather than returning nothing, and
  so does one issued with a whitespace tenant.
- `TenantNotBoundError` — the Python-side half of the same rule — raises for
  a scoped ORM row, a plain `Table()` junction insert and a membership write
  with nothing bound, in
  `tests/switch_core/db/test_require_tenant_id.py`. It arrives wrapped in a
  `StatementError` when a column default raises it, which that file pins
  too, because a caller catching `SQLAlchemyError` would otherwise swallow
  it.
- `ensure_system_client` creates one admin client per tenant, on a fresh
  database and on a deployment that gained a tenant between two boots
  (`tests/switch_core/clients/test_ensure_system_client.py`). It had no test
  at all until it stopped booting.
- **`room_service.py`'s bindings, asked of Postgres**
  (`tests/switch_core/test_room_service_tenant_bindings.py`). Worth its own
  entry because of how it came about: `tenant_scope`, `tenant_session` and
  the tenant lookups could be shadowed with no-ops inside that one module and
  the suite still passed, 2833 to 2833 — the largest file in the rework, and
  nothing depended on a single binding it made. Two things had to change for
  a test to be able to tell. It reads
  `current_setting('app.tenant_id')` on the session the service handed the
  store, rather than asserting on rows: the unit suite connects as the tables'
  owner, so a session that forgot its tenant writes exactly as much as one
  that remembered, and the setting is the only remaining difference. And it arranges two tenants, which nothing else in the suite
  does, because half of what these bindings are for is only observable once a
  second tenant owns something. Shadowing the three helpers now fails five of
  its eight tests; that experiment is the file's acceptance criterion and is
  written down in its module docstring.
- **`get_by_type` is per tenant, and boot records the tenant off each row**
  (`tests/switch_core/clients/test_client_registry_tenants.py`). Reverting the
  filter reproduces `ForeignKeyViolationError` on `fk_client_rooms_client`
  through the room-service tests above, which is the shape the bug took at
  startup.
- **The startup admin seeding rejoins a stranded admin**
  (`tests/switch_core/test_seed_admin_membership.py`), and the same file pins
  what being stranded costs — `get_sole_tenant_id` raising — so the repair is
  measured against the failure it prevents rather than against itself.
- **The log line names the tenant the transaction writes**
  (`tests/switch_core/test_logging_config.py`), reading the value from
  `require_tenant_id()` rather than restating a constant, so the two cannot
  drift apart again.
- **Removing a server-side connector is scoped and fails loudly**
  (`tests/switch_core/bridges/agent/server_connectors/test_lifecycle_remove_tenant.py`),
  against `rls_harness.restricted` — the plain fixture is the owner and would
  pass with no policies at all. It covers both halves: the delete refuses to
  report a removal it did not make, and it refuses *before* tearing the
  connector down, since `_cores` spans tenants and the teardown would
  otherwise be a cross-tenant outage discovered one statement too late.
- A reference type whose slug clashes *while another tenant holds the same
  slug* still reports "already exists" rather than a 500
  (`tests/switch_core/db/stores/test_reference_type_store.py`).
  `ReferenceTypeStore.create` names the clashing row by looking it up inside
  its own `IntegrityError` handler, with a `scalar_one_or_none()`; the slug is
  only unique per tenant, so an unfiltered lookup there matches two rows and
  raises `MultipleResultsFound` from inside the handler — turning the 400
  `gateway/references.py` maps `ValueError` to into an unhandled 500. The
  lookup names the row's own tenant, and the arrangement that tells the two
  apart needs the slug present in two tenants at once, which no
  single-tenant test could produce.

The foreign-key-carries-`tenant_id` catalogue check this section originally
asked for shipped earlier, with the schema migration — see
`tests/switch_core/db/test_tenant_schema_catalogue.py`, predating row-level
security because it needed no policy to be meaningful.

## What Phase 1 does not close

Named so they are decisions rather than omissions.

- **`mode: existing` expects its runtime role to be created out of band.** The
  chart cannot create a role in a database it does not own, so an RDS or other
  managed-database deployment runs the SQL in `docs/old/rds-migration.md`
  itself, once, and `requireRestrictedRole: false` is the escape hatch for the
  window before it has. `mode: managed` is deliberately *not* in this list any
  more: the chart owns that Postgres, so it creates the runtime role itself —
  from an initdb script on a fresh volume, and from a pre-upgrade hook Job on
  a deployment that predates the role, since initdb never runs twice — and
  points `DB_USER` at it. That was the one mode where the chart could fix it,
  and leaving it unfixed would have made the chart's default install the only
  deployment shape with no isolation in it.
- **`unscoped_session`'s allowlist was load-bearing and is now only an
  audit.** While that helper existed, the list of its callers *was* the
  isolation boundary and a missing entry was a leak. Nothing is enforced by a
  list any more — the database refuses — so
  `test_tenant_exemption_allowlist.py` is an inventory a reviewer can read
  rather than a control. Worth knowing when reading it, since it looks like
  the same thing.
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
  day a second one exists; the session being tenant-scoped is what makes them
  correct, and until the runtime role lands that is true of the policies
  rather than of the connection. `client_store.get_by_matrix_user_id` is now
  reachably ambiguous rather than theoretically so, because the admin client
  is one row per tenant and every one of them carries the same
  `@switch-admin:<server>` id.
- **`INSERT … ON CONFLICT` against a row the policy hides behaves two
  different unhelpful ways.** `DO NOTHING` reports zero rows inserted, which
  the caller reads as "already there" when in fact it is another tenant's
  row and the caller's own is now missing. `DO UPDATE` raises *"new row
  violates row-level security policy (USING expression)"*, which is an
  existence oracle for a row the caller may not see. Both measured on 16.
  Not reachable today: every conflict target in this tree is a UUID or a
  hash, so a conflict across tenants would need a guessed identifier. It is
  reachable the moment a natural key gains an upsert, so it is recorded
  rather than fixed — the fix is to include `tenant_id` in the conflict
  target, which the composite unique constraints already permit.
- No plan, status or soft-delete on `tenants`; no tenant deletion; no
  per-tenant feature flags; no tenant switching.
- No per-tenant agent registration credential — Phase 2 owns it as a security
  item, not a refactor.
- No renaming of the residual `matrix_*` columns. Worth doing while these
  tables are open, but not in the migration that changes isolation.
- The room advisory lock hashes only the room id, so it is a cluster-global
  namespace shared across tenants. Harmless at today's scale, worth a note.
