"""The whole exemption from row-level security, written out as eight functions.

Row-level security is enforced by `require_tenant_id()` (`db/rls_ddl.py`),
which raises when no tenant is bound. That is the property everything else
rests on, and it has one unavoidable consequence: **resolving who the caller
is is what produces the tenant, so it necessarily runs unbound.** A bearer
token names an `api_keys` row before anyone knows which tenant that row is in.
A boot pass over every bridge has to see rows in tenants it has not bound yet.
Both are reads the policy refuses.

The design this replaces called that an "unscoped session" and left it at
that. Under the owner connection every environment used, an unscoped session
did read across tenants, so the model looked complete. Under a restricted
role it is not a hatch at all — unscoped is precisely the state
`require_tenant_id()` raises on — and a real deployment under a restricted
role died at the first of nineteen such sites before it finished booting:
seventeen of them the `unscoped_session` helper's own call sites
(`db/session_scope.py`), and two more raw-session credential reads that
leaned on the same ownership exemption without ever calling it.

**What is exempt is this module, and nothing else.** Each function below is
`SECURITY DEFINER`, owned by the schema owner, and so runs outside the
policies (Postgres exempts a table's owner from its own policies, and this
design deliberately never sets `force row level security` — see
`test_tenant_lookup.py`, which pins that). Two properties make the exemption
worth having:

- **They answer *which tenant*, never *what row*.** Every one returns
  `setof text`: tenant ids. What exactly that does and does not concede is
  worth stating precisely, and is stated below rather than summarised here,
  because the obvious summary of it is false.
- **They are a closed list.** `TENANT_LOOKUPS` below is the list; a test
  compares it against the functions actually installed, against the
  migration's frozen copy, and against what each one answers when called as
  the restricted role. Adding one is an edit a reviewer sees, and is meant to
  be argued with rather than waved through.

**What the exemption gives, stated exactly.** Every lookup returns `setof
text` — tenant ids, never a row of a scoped table. That much is the part
worth having: no customer data crosses a tenant boundary through this module,
on any function, for any argument.

Three things the shorter statement of that property — "the most any caller can
extract is the tenant of an identifier it already holds" — got wrong, all of
them about *metadata* rather than rows:

1. `all_tenant_ids()` takes no identifier. It enumerates the deployment: how
   many tenants there are and what their ids are. Nothing about it is narrowed
   to what the caller already holds, and nothing can be — the boot fan-outs
   and the runtime-state sweep exist precisely to visit tenants the caller has
   never heard of.
2. `EXECUTE` used to be left at the `PUBLIC` default a new function gets, so
   any role with `CONNECT` on this database could call every one of them. That
   is closed: `grant_runtime_role` revokes `EXECUTE` on the schema's functions
   from `PUBLIC` and grants it to the runtime role by name, and the boot
   self-check refuses to serve if `PUBLIC` has it back.
3. `users` and `oidc_identities` carry no tenant and so no policy
   (`db/rls_ddl.py`'s `GLOBAL_TABLES`) — a person is global, and the
   per-tenant object is the `tenant_members` row. A session with nothing bound
   may therefore read every user id, and feeding those one at a time to
   `tenants_of_user` reconstructs the whole user-to-tenant membership graph.
   That follows from the schema rather than from this module, and it is not
   closed here.

So the property this design actually holds is: **the exemption discloses the
shape of the deployment — which tenants exist, and which tenant a given user,
credential, room, bridge, connector or invitation belongs to — and no row of
any tenant-scoped table.** It is a boundary on data, not on metadata. Narrowing
the second is a question about who may hold the runtime role's credentials at
all, since everything above is reachable by anyone who has them.

Everything else in the process binds a tenant. The nineteen sites that could
not are now one of three shapes, and the shape is the interesting part:

1. **Credential resolution** — the bearer token, the JWT subject, the OIDC
   client id, the registration token. Resolve the *tenant* here, bind it,
   then read the row itself through the ordinary scoped store. The row never
   arrives from an exempt path.
2. **Cross-tenant enumeration** — the boot passes over every client, bridge,
   connector and room, and the runtime-state sweep. `all_tenant_ids()` and
   then one scoped pass per tenant. These sites already fanned out per row
   and bound that row's tenant; the loop simply moved one level up, and the
   read inside it is now subject to the policies like any other.
3. **Per-item work that can derive its tenant** — a bridge or connector being
   started by id, a room reached by id. One lookup by the globally unique
   identifier the caller already has, and everything after it is scoped.

**A lookup whose caller already knows the answer does not belong here.** There
was one more, `tenant_of_client`, and it was the one called most: every
client's transport asked it, once per transport, and so did every agent
client's `start`. Both were built from a `clients` row that names the tenant
in a column, so the question was asked of the database with the answer already
in hand. `ClientBase` and `PostgresTransport` now take a `tenant_id` the way
they take a `client_id`, and revision `b1d7c4f0a92e` drops the function. The
test that keeps the list honest is the one that would have let this stand: a
function nobody needs is still a function every role could call, so the shorter
list is the whole point of noticing.

**`tenant_of_invitation` is the eighth, and it is the same shape as
`tenant_of_api_key`.** Accepting an invitation is credential resolution: the
request carries a token and nothing else, no tenant is bound yet, and the
table it would have to read (`invitations`) is tenant-scoped like everything
else, so the policy refuses exactly the read that has to happen first. Resolve
the tenant here, bind it, then read the invitation itself — its role, its
email, whether it is spent or revoked — through the ordinary scoped store.
Nothing about *that* row crosses the exemption; only the tenant id does, which
is the property every lookup in this module rests on.

Why not the obvious alternatives is argued in
`docs/old/multi-tenancy-phase1-db.md`, "The bootstrap problem"; the short
version is that returning rows instead of tenant ids would put a second copy
of a dozen store methods in SQL and widen the exemption from "a tenant id"
to "any row of every table they read", and that a second engine connected as the owner
would make the exemption ambient again — reachable from anything holding the
factory, and no longer a list anybody can read.

**A fan-out over `all_tenant_ids()` filters what it reads back.** Every such
loop keeps only the rows whose own `tenant_id` matches the tenant it bound.
That looks redundant — the policy has already narrowed the read — and it is
not, because the policy is what does *not* apply on an owner connection. Most
store methods here carry no `WHERE tenant_id = …` of their own and lean on
row-level security for it, so on a connection Postgres exempts (the test
suite's, and any deployment still running with
`DB_REQUIRE_RESTRICTED_ROLE=false`) the same read returns every tenant's rows
on every pass, and a fan-out over N tenants acts on each row N times. Silent
duplication is exactly the failure this design refuses to ship, so the filter
is written out rather than inferred from the connection.

**Cost.** A lookup is its own short session and so its own round trip. On the
paths where that would be per request or per message it is already behind a
cache that predates this change (`ApiKeyCache`, the transport's room map, the
bridge's room→tenant map), so the steady-state cost is one extra round trip
per *new* credential, room or bridge rather than per use. `all_tenant_ids()`
on the runtime-state sweep is one extra round trip every five seconds.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import DDL, MetaData, TextClause, event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.tenant_context import no_tenant


class TenantLookupError(RuntimeError):
    """A lookup that must name at most one tenant named several.

    Only reachable for a key that is not unique by constraint — today only
    `agents.oauth_client_id`, which has no unique index. Raised rather than
    resolved by picking one, for the same reason `get_sole_tenant_id` refuses
    to: a credential that resolves to two tenants is a provisioning fault, and
    guessing which one it meant is how a caller ends up authenticated into
    somebody else's data.
    """


@dataclass(frozen=True)
class TenantLookup:
    """One exempt function: its name, its single argument, and what it reads.

    `argument` is the parameter name *without* the `p_` prefix the SQL carries.
    The prefix is not decoration: a `LANGUAGE sql` function whose parameter is
    spelled like a column of a table in its own query resolves the name to the
    column, silently, rather than to the parameter. Verified on Postgres 16,
    because it is easy to get backwards: against a table that has a
    `client_id` column, `WHERE id = client_id` becomes a comparison between
    two columns of the same row, `id` and the table's own `client_id`, which
    is false for every row whose `client_id` does not happen to equal its
    `id` — a confident, silent *zero* rows, not every row. The sharper
    failure needs the parameter named after the very column being compared:
    `tenant_of_api_key(key_hash text) ... WHERE key_hash = key_hash` shadows
    to a column compared with itself, true unconditionally, and *that* matches
    every row regardless of the argument. Either shape is a caller left
    unable to resolve a tenant it should have found, or handed every tenant
    the row could belong to, in place of the one it actually named —
    so prefixing every parameter makes the shadowing unrepresentable rather
    than a thing to check per function, whichever direction it would have
    failed.
    """

    name: str
    argument: str | None
    query: str
    purpose: str

    @property
    def parameter(self) -> str | None:
        return None if self.argument is None else f"p_{self.argument}"

    @property
    def signature(self) -> str:
        return f"{self.name}({'' if self.argument is None else 'text'})"


# The seven of them. Ordered as the three shapes above: enumeration, then
# credential resolution, then deriving a tenant from an identifier in hand.
TENANT_LOOKUPS: tuple[TenantLookup, ...] = (
    TenantLookup(
        name="all_tenant_ids",
        argument=None,
        query="SELECT id FROM tenants ORDER BY created_at, id",
        purpose=(
            "Every tenant in the deployment, oldest first. The one question a "
            "scoped session cannot answer about itself, and the whole of what "
            "the boot enumerations and the runtime-state sweep need."
        ),
    ),
    TenantLookup(
        name="tenants_of_user",
        argument="user_id",
        query=(
            "SELECT tenant_id FROM tenant_members "
            "WHERE user_id = p_user_id ORDER BY tenant_id"
        ),
        purpose=(
            "Which tenants a gateway login belongs to. A person is global "
            "(`users` carries no tenant); the membership row is the per-tenant "
            "object, and it is scoped, so a session cannot read its own way in."
        ),
    ),
    TenantLookup(
        name="tenant_of_api_key",
        argument="key_hash",
        query="SELECT tenant_id FROM api_keys WHERE key_hash = p_key_hash",
        purpose=(
            "Which tenant a bearer credential belongs to. `api_keys.key_hash` "
            "is one of the two columns deliberately left globally unique for "
            "exactly this: the hash is resolved before a tenant exists."
        ),
    ),
    TenantLookup(
        name="tenant_of_agent_oauth_client",
        argument="oauth_client_id",
        query=(
            "SELECT tenant_id FROM agents WHERE oauth_client_id = p_oauth_client_id"
        ),
        purpose=(
            "Which tenant an agent authenticating by OIDC belongs to. The "
            "column carries no unique index, so this is the one lookup that "
            "can legitimately answer twice; the caller refuses rather than "
            "picking."
        ),
    ),
    TenantLookup(
        name="tenant_of_room",
        argument="room_id",
        query="SELECT tenant_id FROM rooms WHERE id = p_room_id",
        purpose=(
            "Which tenant a room belongs to, for work reaching a room by its "
            "globally unique id with nothing bound."
        ),
    ),
    TenantLookup(
        name="tenant_of_collaboration_bridge",
        argument="bridge_id",
        query="SELECT tenant_id FROM collaboration_bridges WHERE id = p_bridge_id",
        purpose=(
            "Which tenant a bridge belongs to. Asked from boot, with nothing "
            "bound, and from an HTTP request that restarted it, where what is "
            "bound is the operator's tenant and not necessarily the bridge's."
        ),
    ),
    TenantLookup(
        name="tenant_of_server_connector",
        argument="connector_id",
        query="SELECT tenant_id FROM server_connectors WHERE id = p_connector_id",
        purpose="Same as the bridge, for a server-side connector.",
    ),
    TenantLookup(
        name="tenant_of_invitation",
        argument="token_hash",
        query="SELECT tenant_id FROM invitations WHERE token_hash = p_token_hash",
        purpose=(
            "Which tenant an invitation belongs to, resolved from the hash of "
            "its token before any tenant is bound — the same credential-"
            "resolution shape as a bearer token, and necessary for the same "
            "reason: accepting an invitation is exactly the read the policy "
            "refuses to a session with nothing bound yet."
        ),
    ),
)

TENANT_LOOKUPS_BY_NAME: dict[str, TenantLookup] = {
    lookup.name: lookup for lookup in TENANT_LOOKUPS
}

# `pg_temp` last, per the Postgres note on writing SECURITY DEFINER functions
# safely: a role that can create a temporary table could otherwise shadow one
# of the tables read above and have the function read theirs instead. `public`
# is not writable by PUBLIC on 15+, which is the floor this schema already
# requires for `ON DELETE SET NULL (col)`.
SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"


def create_lookup_ddl(lookup: TenantLookup) -> str:
    parameters = "" if lookup.parameter is None else f"{lookup.parameter} text"
    return (
        f"CREATE OR REPLACE FUNCTION {lookup.name}({parameters})\n"
        f"    RETURNS SETOF text\n"
        f"    LANGUAGE sql STABLE SECURITY DEFINER\n"
        f"    SET search_path = {SECURE_SEARCH_PATH}\n"
        f"AS $${lookup.query}$$"
    )


def drop_lookup_ddl(lookup: TenantLookup) -> str:
    return f"DROP FUNCTION IF EXISTS {lookup.signature}"


def attach_tenant_lookups(metadata: MetaData) -> None:
    """Create every lookup after `create_all`, drop them before `drop_all`.

    On the metadata's own events rather than a table's, and *after* create
    rather than before: a `LANGUAGE sql` body is parsed and its names resolved
    when the function is created, so every table it reads has to exist by
    then. That is a feature — a lookup naming a column that has been renamed
    fails at `create_all`, in every test, rather than at the first call in a
    deployment.
    """
    for lookup in TENANT_LOOKUPS:
        event.listen(
            metadata,
            "after_create",
            DDL(create_lookup_ddl(lookup)).execute_if(dialect="postgresql"),
        )
        event.listen(
            metadata,
            "before_drop",
            DDL(drop_lookup_ddl(lookup)).execute_if(dialect="postgresql"),
        )


# ── Calling them ──────────────────────────────────────────────────────────────

# One `text()` per lookup, written out rather than assembled from `lookup.name`
# at call time: the eight names are fixed and known here, so there is nothing
# for a call site to build. The assertion below is what keeps this dict from
# quietly falling behind `TENANT_LOOKUPS` — a ninth lookup with no entry
# here fails at import, not with a `KeyError` on whatever request reaches it
# first.
_LOOKUP_STATEMENTS: dict[str, TextClause] = {
    "all_tenant_ids": text("SELECT tenant_id FROM all_tenant_ids() AS tenant_id"),
    "tenants_of_user": text(
        "SELECT tenant_id FROM tenants_of_user(:argument) AS tenant_id"
    ),
    "tenant_of_api_key": text(
        "SELECT tenant_id FROM tenant_of_api_key(:argument) AS tenant_id"
    ),
    "tenant_of_agent_oauth_client": text(
        "SELECT tenant_id FROM tenant_of_agent_oauth_client(:argument) AS tenant_id"
    ),
    "tenant_of_room": text(
        "SELECT tenant_id FROM tenant_of_room(:argument) AS tenant_id"
    ),
    "tenant_of_collaboration_bridge": text(
        "SELECT tenant_id FROM tenant_of_collaboration_bridge(:argument) AS tenant_id"
    ),
    "tenant_of_server_connector": text(
        "SELECT tenant_id FROM tenant_of_server_connector(:argument) AS tenant_id"
    ),
    "tenant_of_invitation": text(
        "SELECT tenant_id FROM tenant_of_invitation(:argument) AS tenant_id"
    ),
}

assert _LOOKUP_STATEMENTS.keys() == TENANT_LOOKUPS_BY_NAME.keys(), (
    "_LOOKUP_STATEMENTS must carry exactly the names in TENANT_LOOKUPS"
)


async def _call(
    session_factory: async_sessionmaker[AsyncSession],
    lookup: TenantLookup,
    argument: str | None = None,
) -> list[str]:
    """Run one lookup on a session of its own, with nothing bound.

    Its own session, deliberately. The caller may have a tenant bound — the
    gateway resolving a bridge's tenant from inside an operator's request does
    — and the answer must not be narrowed to it. Nothing bound is also the
    honest state: this session may not touch a scoped table, and the database
    is what enforces that now rather than an allowlist.
    """
    parameters: dict[str, object] = {}
    if lookup.parameter is not None:
        parameters["argument"] = argument
    with no_tenant():
        async with session_factory() as session:
            result = await session.execute(_LOOKUP_STATEMENTS[lookup.name], parameters)
            return [row[0] for row in result]


def _at_most_one(lookup: TenantLookup, tenant_ids: Iterable[str]) -> str | None:
    found = list(tenant_ids)
    if len(found) > 1:
        raise TenantLookupError(
            f"{lookup.name} resolved {len(found)} tenants ({sorted(found)}); "
            "refusing to pick one. Whatever was looked up is present in more "
            "than one tenant, which is a provisioning fault, not a credential "
            "the caller may use."
        )
    return found[0] if found else None


async def all_tenant_ids(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[str]:
    return await _call(session_factory, TENANT_LOOKUPS_BY_NAME["all_tenant_ids"])


async def tenants_of_user(
    session_factory: async_sessionmaker[AsyncSession], user_id: str
) -> list[str]:
    return await _call(
        session_factory, TENANT_LOOKUPS_BY_NAME["tenants_of_user"], user_id
    )


async def tenant_of_api_key(
    session_factory: async_sessionmaker[AsyncSession], key_hash: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_api_key"]
    return _at_most_one(lookup, await _call(session_factory, lookup, key_hash))


async def tenant_of_agent_oauth_client(
    session_factory: async_sessionmaker[AsyncSession], oauth_client_id: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_agent_oauth_client"]
    return _at_most_one(lookup, await _call(session_factory, lookup, oauth_client_id))


async def tenant_of_room(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_room"]
    return _at_most_one(lookup, await _call(session_factory, lookup, room_id))


async def tenant_of_collaboration_bridge(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_collaboration_bridge"]
    return _at_most_one(lookup, await _call(session_factory, lookup, bridge_id))


async def tenant_of_server_connector(
    session_factory: async_sessionmaker[AsyncSession], connector_id: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_server_connector"]
    return _at_most_one(lookup, await _call(session_factory, lookup, connector_id))


async def tenant_of_invitation(
    session_factory: async_sessionmaker[AsyncSession], token_hash: str
) -> str | None:
    lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_invitation"]
    return _at_most_one(lookup, await _call(session_factory, lookup, token_hash))
