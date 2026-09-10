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
under "Done when" are all in place, in the migration `265ed188ad6f`. Read the
remaining sections as a description of what is running today, except where a
section says otherwise; "What Phase 1 does not close" says which gaps remain
deliberately open — the runtime role that would make these policies bite in a
deployed environment is the biggest of them, tracked separately as CHOO-2685.

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

**Resolution runs before the tenant exists, on a short-lived session.**
Answering "which tenant does this caller belong to" is by definition unscoped.
It happens on a session opened and closed inside the authenticating dependency,
before the request's own session is touched. An earlier attempt held that
second session open for the whole request; that both halved the connection pool
and, because the `User` it returned belonged to a session nobody committed,
silently discarded a password change. Resolution needs the subject id, not a
`User` row — so it looks up only the membership, and the user is loaded from
the session the endpoint actually commits.

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
- **The lookups that produce a tenant are unscoped, not scoped to a guess.**
  Which room is this transport id? Which rooms is this client in? Which agent
  is this client? Which tenant is this bridge in? Each is asked before the
  answer is known, so binding one first is either a tautology or, under
  policies, a false "not found". These use `unscoped_session`, the same as the
  credential lookups in the bootstrap section below.

Two named helpers carry this: `tenant_session` (`db/session_scope.py`) binds a
given tenant and opens a session; `unscoped_session` **unbinds** for the
duration of the block and opens one with nothing set, restoring the caller's
binding on the way out. The unbinding is the point and was the second thing
the first attempt got wrong: a helper that only *named* the intent while
inheriting whatever was ambient has the hook stamp the caller's tenant onto
the transaction, so the cross-tenant read the call site asked for is silently
a single-tenant one — and the allowlist pinning it certifies a lie.

`tests/switch_core/db/test_unscoped_session_allowlist.py` pins two lists,
both derived from the source tree rather than from imports. The first is who
may call `unscoped_session`, and it resolves the local name the helper was
bound to rather than matching the spelling, so `import … as` does not walk
past it. (The second cannot do the same: every service is handed its own
factory, so there is no single definition to resolve. It matches on the name
ending in `session_factory`, which is over-eager rather than under-eager —
the safe direction for an audit — with the two accessors that hand a factory
back rather than open a session named as exceptions.) The second is the one that matters more: **which modules
may open a session straight from the factory at all.** A raw call inherits
whatever is ambient, which in background code is now nothing — so it is
unscoped in fact while declaring nothing, strictly worse than the hatch that
announces itself. Those 174 call sites across nineteen modules are the
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

The same context value feeds the logging filter, which has had a `tenant_id`
field since before tenants existed and which nothing has ever bound
per-request. That closes half of Phase 0's logging item as a side effect.

## The bootstrap problem, and the two exceptions

Authentication happens before a tenant is known — resolving an API key by hash,
or a JWT subject to its memberships, is unscoped by definition. So:

> **Authentication and tenant resolution run in a system session. Everything
> downstream runs in a tenant session, as the restricted runtime role.**

The same escape hatch — `unscoped_session`, see above — covers work that is
legitimately cross-tenant: Alembic (a bare `Connection`, not a session at all,
so it never touches the helper either way), admin and bootstrap seeding at
startup, the bridge and connector lifecycle loops that start every row at
boot, and the runtime-state sweep. (The connection sweep touches no scoped
table — it expires in-memory `Connection` objects on a heartbeat timeout —
so it needed no exception in the first place.)
`tests/switch_core/db/test_unscoped_session_allowlist.py` pins the set of
modules allowed to call it, so a new one is a deliberate act rather than an
accident.

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

One thing the transport deliberately does *not* do is treat its client as
belonging to a tenant. `joined_rooms` is unscoped, because it runs once and
decides what that client will ever hear: a tenant over that read returns a
subset with no error to say so, and the client is then silently deaf in every
room it did not see, forever. The client id it reads by is globally unique, so
there is nothing for a tenant to disambiguate. (A client cannot in fact be a
member of another tenant's room — `client_rooms` carries composite foreign
keys to both `clients` and `rooms`, so the system client is one row per tenant
rather than one row in every tenant's rooms. The transport does not lean on
that; it is pinned by a test in
`tests/switch_core/transport/test_postgres_transport.py` because the shape of
the room list rests on it.)

Three exceptions to the uniform rule, in full:

1. **`api_keys.key_hash` stays globally unique**, because authentication
   resolves it before a tenant exists.
2. **System sessions bypass policies by ownership.** This is a fail-open hatch
   inside a fail-closed design and is named as such: nothing stops a pinned
   module reading across tenants once a second one exists. Phase 1 accepts
   that; the pinned list is what keeps it reviewable.
3. **The agent-registration bootstrap key is seeded on an unbound
   transaction, and writes two scoped rows there.** Everything else that
   writes with nothing bound was converted to name its tenant; this one
   cannot be, because the same block genuinely spans tenants — the key is
   one per deployment, resolved by that globally unique hash, and the
   admin-owned-agent warning beside it must see every tenant's agents or it
   under-reports the case it exists to flag. So the block stays unscoped and
   the two scoped rows in it, the bootstrap owner's membership and the
   `ApiKey`, name tenant zero themselves. That works today only because
   startup connects as the table owner. When the runtime role lands
   (CHOO-2685) this path needs a system connection of its own; it is the one
   place in the tree where "unscoped session" and "scoped write" meet, and it
   is listed here rather than left for that work to discover.

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

What shipped as one design landed as two revisions: the schema
(`8b276792ee30`) below, and row-level security (`265ed188ad6f`, "Where the
SQL lives" above) after it. Splitting them was not the original plan — it
fell out of building this in stages — but it turned out to be the right
shape anyway: the schema migration is safe to run and roll back on its own,
with every policy still inert against the owner connection either way, and
the second revision is a short, mechanical follow-on with nothing but
`require_tenant_id()` and 38 near-identical `enable row level security` /
`create policy` pairs to review.

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

No roles are created and no grants issued, in either revision — see the role
section above. Row-level security is not part of the schema revision: it is
the second one, `265ed188ad6f`, which creates `require_tenant_id()` and every
table's policy and nothing else — no roles or grants there either, for the
same reason.

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
it, connects as it, and seeds tenant zero against a schema built the same way
`session_factory` builds one — because the rest of the suite still runs
against the owner connection, and always will until the role in the section
above exists somewhere real.

Note what this does and does not prove. It proves the **policies** are correct,
which is the part Phase 1 owns. It does not prove the **deployment** is subject
to them — that is the role work, and until it lands the same test against a
real environment would pass for the wrong reason.

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

- **The policies exist and do not yet bite.** `require_tenant_id()` and every
  table's policy are built and tested (`265ed188ad6f`,
  `tests/switch_core/db/test_row_level_security.py`), but local Compose, the
  chart and production all still connect as the table owner, which bypasses
  row-level security by ownership regardless of what the policies say. The
  runtime role that would make a policy bite in a deployed environment —
  `switch_app`, described above — is CHOO-2685, not this phase. Deliberate,
  and safe while one tenant exists — and the hard prerequisite for the
  second.
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
- **`RoomService._resolve_system_clients` is tenant-blind**, and now that
  `ensure_system_client` makes one admin client per tenant there is more than
  one for it to be blind about. It returns every running system client, and
  both callers — creating a room, and `reconcile_room_clients` at startup —
  put all of them in the room. With two tenants that means offering tenant
  B's admin client to tenant A's room, which `client_rooms`' composite
  foreign key refuses, so the failure is loud rather than a leak. It was
  equally broken before, in the other direction: one admin client in tenant
  zero, offered to every tenant's rooms, refused the same way. The fix is a
  filter on the room's tenant at both call sites, and it belongs with
  whatever onboards the second tenant rather than in the change that made
  the row exist.
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
