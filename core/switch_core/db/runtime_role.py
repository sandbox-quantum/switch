"""Making the policies bite: the restricted runtime role, and proving it is one.

Every policy in `db/rls_ddl.py` is inert against a superuser or a table owner
— Postgres exempts both, the first unconditionally and the second because this
design deliberately never sets `force row level security` (which is also what
lets the exempt lookups in `db/tenant_lookup.py` work at all). So the schema
half of tenant isolation is only worth what the connection is: a deployment
that installs 38 policies and then connects as the owner has none of them.

Two halves live here.

**Grants.** The runtime role owns nothing and can create nothing, so it needs
to be given access to every table the owner created. The actual mechanism is
the explicit `GRANT`s, re-issued fresh on every boot, immediately after the
migration that may have added a table: naming everything the schema contains
at that moment cannot fall behind it, the way a rule that has to fire once per
object, at the moment of its creation, can. The `ALTER DEFAULT PRIVILEGES`
statements alongside them are belt to that grant's braces, not a second
mechanism for the same job: they cover whatever the owner creates *between*
one boot and the next, at the cost of being easy to get subtly wrong as a
strategy on their own — the setting is per-granting-role, and silently grants
nothing for an object some other role creates — a gap the next boot's fresh
`GRANT` closes regardless of whether the default privilege fired. Both are
idempotent and cost one round trip at boot.

**Revokes, for the same reason in reverse.** `EXECUTE` on a new function is
granted to `PUBLIC` by default, so the exempt lookups in `db/tenant_lookup.py`
arrive callable by every role that can connect to this database. Nothing about
that is deliberate — it is the shape a `CREATE FUNCTION` has, and the
migration that installs them has no role name to grant to. So the same pass
takes it away and grants `EXECUTE` to the runtime role by name, which makes
the grant, rather than a default, the reason those functions are callable at
all.

**The self-check.** Questions asked of the runtime connection before the
server listens, in increasing order of how much they prove, because this
failure mode is silent and CI cannot ask it: CI has no production connection,
and a Switch that believes it is isolating tenants and is not looks exactly
like one that is.

1. The role is not a superuser and carries no `BYPASSRLS`, nor is it a member
   of a role that has either — membership is a `SET ROLE` away from both.
2. It owns none of the tables carrying a policy, nor inherits the privileges
   of a role that does.
3. No scoped table has `force row level security`, which would take the
   ownership exemption away from the lookup functions and leave the process
   unable to resolve a credential at all.
4. Every scoped table still has row-level security switched on and still
   carries its policy — the schema half of the guarantee, which a check about
   the connection alone cannot prove; a table someone quietly disarmed would
   pass every check above it.
5. Every tenant lookup exists and this role may execute it, since a role that
   cannot would authenticate nobody.
6. `PUBLIC` may *not* execute them, so the exemption is reachable through the
   runtime role's credentials rather than by anything holding a connection.
7. **A read of `tenants` with nothing bound raises.** This is the one that
   actually proves it, because the others are inferences from the catalogue
   and this is the behaviour. `tenants` is the table to ask it of: the check
   is only meaningful against a populated table — Postgres does not evaluate a
   policy for a scan that yields no rows, so an empty table answers "no error"
   whether or not the connection is exempt — and `tenants` is the one scoped
   table guaranteed to hold a row, since tenant zero is inserted by the same
   migration that creates it. Asked last, and on a connection of its own,
   because a statement that raises aborts its transaction.

A failure raises and the process exits. `DB_REQUIRE_RESTRICTED_ROLE=false`
turns the check into an `error` log for a deployment that has not created its
role yet; nothing turns it into silence.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

# Imported for its side effect: registering every table on `Base.metadata`, so
# `scoped_tables` below answers with the schema this process expects rather
# than with an empty set — which would make the policy check pass vacuously.
import switch_core.db.models  # noqa: F401
from switch_core.db.base import Base
from switch_core.db.rls_ddl import POLICY_NAME, scoped_tables
from switch_core.db.tenant_lookup import TENANT_LOOKUPS

logger = logging.getLogger(__name__)

# What `require_tenant_id()` raises with, on both counts. The self-check
# insists on the code *and* the message, and the second is not belt and
# braces: SQLSTATE 42501 is `insufficient_privilege`, which is also what
# Postgres returns for `permission denied for table tenants`. A role that had
# simply never been granted anything would otherwise satisfy the probe by
# failing for an unrelated reason — the exact false pass this check exists to
# prevent, arrived at from the other direction.
TENANT_NOT_SET_SQLSTATE = "42501"
TENANT_NOT_SET_MESSAGE = "app.tenant_id is not set"


class RuntimeRoleError(RuntimeError):
    """The runtime connection is not subject to the row-level-security policies."""


async def grant_runtime_role(owner: AsyncConnection, role: str) -> None:
    """Give `role` everything a runtime role needs and nothing more.

    Run as the owner, after `alembic upgrade head`. `EXECUTE ON ALL FUNCTIONS`
    covers `require_tenant_id()` and the tenant lookups without naming them,
    so an eighth lookup needs no change here.

    The plain `GRANT`s are what actually does the job, and doing it fresh on
    every boot is what keeps it from falling behind: it names every table,
    sequence and function the schema holds at that moment, so it cannot miss
    one the way a rule that has to fire once per object, at creation, can. The
    `ALTER DEFAULT PRIVILEGES` statements after them are belt to that grant's
    braces, covering an object the owner creates between this boot and the
    next — at the cost of being unfit to carry the job alone, since the
    setting is per-granting-role and silently grants nothing for an object
    some other role creates. The next boot's fresh `GRANT` would close that
    gap either way, which is why the default privileges are additional rather
    than load-bearing on their own.

    **The two revokes are what make the grant mean something.** Without them
    `EXECUTE` on the tenant lookups stays at the `PUBLIC` default a new
    function is created with, so every role with `CONNECT` on this database
    can resolve which tenant any user, credential, client, room, bridge or
    connector belongs to — see `db/tenant_lookup.py` on what that discloses.
    Revoking from `PUBLIC` and granting to `role` by name replaces "callable
    by anyone" with "callable by the process".

    Two things must survive that revoke, and it is worth saying which and why
    rather than trusting the blanket grant to have covered them.
    `require_tenant_id()` is called by every policy and is evaluated as the
    *querying* role, so a runtime role without `EXECUTE` on it cannot read or
    write a single scoped table — measured on 16: the read fails with
    `permission denied for function require_tenant_id`, not with a policy
    refusal, which is a boot-time outage dressed up as an authorization error.
    The delivery trigger in `db/notify_ddl.py` is the opposite case: a trigger
    function's `EXECUTE` is checked when the trigger is created, not each time
    it fires, so an insert succeeds for a role that may not call it — also
    measured, also on 16. The blanket `GRANT EXECUTE ON ALL FUNCTIONS` covers
    both regardless, and `verify_restricted_role` exercises the first on every
    boot.

    The default-privileges revoke carries no `IN SCHEMA`, unlike every other
    statement here, and that is not an oversight. A per-schema default ACL is
    *unioned* with the built-in one rather than replacing it, so
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS
    FROM PUBLIC` records nothing and a function created after it is still
    `PUBLIC`-executable — verified on Postgres 16, where it leaves
    `pg_default_acl` empty and the new function's `proacl` null. The
    schema-less form is the one that takes, and it is the right scope anyway:
    it is a statement about what this owner creates, and this owner creates
    only this schema.

    No `CREATE` on the schema, and no ownership: the role is meant to be
    unable to alter the tables it reads, which is what keeps it subject to
    their policies.
    """
    identifier = await _quoted_identifier(owner, role)
    for statement in (
        f"GRANT USAGE ON SCHEMA public TO {identifier}",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {identifier}",
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {identifier}",
        "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
        f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {identifier}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {identifier}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {identifier}",
        "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO {identifier}",
    ):
        await owner.execute(text(statement))


async def _quoted_identifier(connection: AsyncConnection, name: str) -> str:
    """`name` as a SQL identifier, quoted by Postgres rather than by us.

    A role name arrives from configuration and lands in `GRANT`, which takes
    no bind parameter for it. `quote_ident` is the server's own quoting, so
    there is no second implementation of it here to get wrong.
    """
    result = await connection.execute(text("SELECT quote_ident(:name)"), {"name": name})
    return str(result.scalar_one())


async def verify_restricted_role(engine: AsyncEngine) -> None:
    """Raise `RuntimeRoleError` unless this connection is subject to the policies."""
    async with engine.connect() as connection:
        role = str((await connection.execute(text("SELECT current_user"))).scalar_one())
        await _refuse_privileged_role(connection, role)
        await _refuse_table_owner(connection, role)
        await _refuse_forced_row_level_security(connection)
        await _require_every_policy(connection)
        await _require_the_lookups(connection, role)
        await _refuse_public_execute(connection)
    # The probe is the one check that provokes an error on purpose, and a
    # statement that raises aborts the transaction it ran in — every query
    # after it on that connection fails with "current transaction is aborted"
    # rather than with what it was asking. So it goes last and gets a
    # connection of its own, and the checks above are the ones whose failures
    # a reader will see first.
    async with engine.connect() as connection:
        await _refuse_a_connection_no_policy_stops(connection, role)
    logger.info(
        "Connected as %s: not a superuser, owns no policied table, and an "
        "unbound read of a scoped table is refused. Tenant isolation is in "
        "force on this connection.",
        role,
    )


async def _refuse_privileged_role(connection: AsyncConnection, role: str) -> None:
    result = await connection.execute(
        text(
            """
            SELECT coalesce(bool_or(r.rolsuper), false) AS is_super,
                   coalesce(bool_or(r.rolbypassrls), false) AS bypasses
            FROM pg_roles r
            WHERE pg_has_role(current_user, r.oid, 'MEMBER')
            """
        )
    )
    is_super, bypasses = result.one()
    session_is_super = (
        await connection.execute(text("SELECT current_setting('is_superuser')"))
    ).scalar_one() == "on"
    if is_super or bypasses or session_is_super:
        raise RuntimeRoleError(
            f"The database role {role!r} is a superuser or carries BYPASSRLS "
            "(directly or through a role it is a member of), so every "
            "row-level-security policy in this schema is inert for it and "
            "tenants are not isolated. Point DB_USER at a plain LOGIN role "
            "with NOSUPERUSER NOBYPASSRLS that owns nothing, and give the "
            "schema owner's credentials as DB_OWNER_USER / DB_OWNER_PASSWORD "
            "so migrations and grants still have somewhere to run."
        )


async def _refuse_table_owner(connection: AsyncConnection, role: str) -> None:
    """Refuse a role that has the owner's privileges, not merely one that is it.

    `pg_has_role(current_user, c.relowner, 'USAGE')` rather than comparing
    names, because that is the test Postgres itself applies: `check_enable_rls`
    asks `has_privs_of_role`, so a role granted membership in the owner with
    `INHERIT` bypasses every policy while being a different role entirely.
    Comparing identities would call that connection clean. Measured on 14 and
    16, not inferred: a plain restricted role is refused the unbound read, an
    inheriting member of the owner reads every row.
    """
    result = await connection.execute(
        text(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relrowsecurity
              AND pg_has_role(current_user, c.relowner, 'USAGE')
            ORDER BY c.relname
            """
        )
    )
    owned = [row[0] for row in result]
    if owned:
        raise RuntimeRoleError(
            f"The database role {role!r} owns, or has the privileges of the "
            f"owner of, {len(owned)} of the tables carrying a tenant-isolation "
            f"policy (for example {owned[:3]}). Postgres exempts a table's "
            "owner — and anything that inherits its privileges — from its own "
            "policies unless FORCE ROW LEVEL SECURITY is set, which this "
            "design deliberately does not set, so those policies do nothing on "
            "this connection. Run the service as a role that owns no table and "
            "is a member of no role that does."
        )


async def _refuse_forced_row_level_security(connection: AsyncConnection) -> None:
    result = await connection.execute(
        text(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relforcerowsecurity
            ORDER BY c.relname
            """
        )
    )
    forced = [row[0] for row in result]
    if forced:
        raise RuntimeRoleError(
            f"FORCE ROW LEVEL SECURITY is set on {forced}. The tenant lookups "
            "in db/tenant_lookup.py are SECURITY DEFINER functions owned by "
            "the schema owner, and they resolve a caller's tenant precisely "
            "because the owner is exempt from these policies. Forcing the "
            "policies onto the owner leaves nothing able to answer 'which "
            "tenant is this credential in', so no request can authenticate."
        )


async def _refuse_a_connection_no_policy_stops(
    connection: AsyncConnection, role: str
) -> None:
    """Read a populated scoped table with nothing bound; insist it is refused.

    The only check here that observes behaviour rather than inferring it from
    the catalogue, and so the only one that would catch an exemption nothing
    above thought to look for.
    """
    try:
        rows = (
            await connection.execute(text("SELECT count(*) FROM tenants"))
        ).scalar_one()
    except DBAPIError as exc:
        if _sqlstate(exc) == TENANT_NOT_SET_SQLSTATE and TENANT_NOT_SET_MESSAGE in str(
            exc
        ):
            return
        raise RuntimeRoleError(
            f"Reading `tenants` as {role!r} with no tenant bound failed, but "
            f"not with {TENANT_NOT_SET_SQLSTATE} "
            f"{TENANT_NOT_SET_MESSAGE!r}: {exc}. That is not the policy "
            "refusing the read, so it says nothing about whether tenants are "
            "isolated — most likely the role is missing its grants, which "
            "raises the same SQLSTATE for an entirely different reason."
        ) from exc
    raise RuntimeRoleError(
        f"Reading `tenants` as {role!r} with no tenant bound returned {rows} "
        "row(s) instead of raising. Something exempts this connection from "
        "the tenant-isolation policies that the checks above did not catch, "
        "so this deployment is not isolating tenants."
    )


async def _require_every_policy(connection: AsyncConnection) -> None:
    """Every scoped table still has row-level security on, and still has its policy.

    The checks above are all about the *connection*, and would each pass on a
    schema somebody had quietly disarmed. `ALTER TABLE messages DISABLE ROW
    LEVEL SECURITY` or `DROP POLICY tenant_isolation ON messages` leaves the
    role restricted, owning nothing, forcing nothing — and leaves `messages`
    readable by every tenant. The behavioural probe would not catch it either,
    since it asks only `tenants`.

    The expected set comes from `rls_ddl.scoped_tables`, the same derivation
    that attached the policies in the first place, so this cannot drift from
    what the schema is supposed to have. `test_tenant_schema_catalogue.py`
    asks the same question of a database built by `create_all`; this asks it
    of the one about to serve traffic, which is the only place the answer can
    have changed.
    """
    expected = set(scoped_tables(Base.metadata))
    rows = await connection.execute(
        text(
            """
            SELECT c.relname, c.relrowsecurity, p.polname IS NOT NULL AS policied
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = :policy
            WHERE n.nspname = 'public' AND c.relkind = 'r'
              AND c.relname = ANY(:names)
            """
        ),
        {"policy": POLICY_NAME, "names": sorted(expected)},
    )
    state = {name: (bool(enabled), bool(policied)) for name, enabled, policied in rows}
    disarmed = sorted(
        name for name in expected if state.get(name, (False, False)) != (True, True)
    )
    if disarmed:
        raise RuntimeRoleError(
            f"{len(disarmed)} scoped table(s) have no tenant-isolation policy, "
            f"or have row-level security switched off (for example "
            f"{disarmed[:3]}). The connection is restricted, but those tables "
            "are readable and writable across every tenant regardless. Either "
            "the schema is behind the migration that installs the policies, or "
            "something has disabled them since."
        )


async def _require_the_lookups(connection: AsyncConnection, role: str) -> None:
    """The exempt lookups must be callable, or nothing can resolve a tenant.

    Checked at boot rather than left to the first request, because the first
    request is an authentication and the failure would arrive as a 401 for
    every caller with no explanation of why.
    """
    expected = {lookup.name for lookup in TENANT_LOOKUPS}
    rows = await connection.execute(
        text(
            """
            SELECT p.proname, has_function_privilege(p.oid, 'EXECUTE')
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = ANY(:names)
            """
        ),
        {"names": sorted(expected)},
    )
    # Existence and privilege in one query rather than
    # `has_function_privilege('name(text)', …)` per lookup: that form raises
    # rather than answering false when the function is absent, so a schema
    # missing the migration would fail with "function does not exist" instead
    # of the explanation below.
    privileges = {name: bool(allowed) for name, allowed in rows}
    missing = sorted(expected - set(privileges))
    if missing:
        raise RuntimeRoleError(
            f"{missing} are not installed in this database. They are the "
            "tenant lookups every credential resolution goes through "
            "(db/tenant_lookup.py), so nothing in this process could "
            "authenticate a caller. The schema is behind the migration that "
            "creates them."
        )
    refused = sorted(name for name, allowed in privileges.items() if not allowed)
    if refused:
        raise RuntimeRoleError(
            f"{role!r} cannot execute {refused}, which are the tenant lookups "
            "every credential resolution goes through (db/tenant_lookup.py). "
            "Nothing in this process could authenticate a caller. Grant "
            "EXECUTE, or let boot do it by configuring DB_OWNER_USER / "
            "DB_OWNER_PASSWORD."
        )
    # Calling one for real, not just asking the catalogue about it. A lookup
    # that exists and is executable can still be unable to *read* — installed
    # SECURITY INVOKER, or owned by a role that has since lost its grants —
    # and the failure that produces is a bare driver error the escape hatch
    # does not catch, so it is turned into a RuntimeRoleError here rather than
    # left to kill a boot that asked to continue.
    try:
        found = (
            await connection.execute(text("SELECT count(*) FROM all_tenant_ids()"))
        ).scalar_one()
    except DBAPIError as exc:
        raise RuntimeRoleError(
            f"all_tenant_ids() is installed and executable by {role!r} but "
            f"could not read: {exc}. It is a SECURITY DEFINER function, so it "
            "reads as its owner — most likely it was not installed as one, or "
            "its owner no longer has access to `tenants`. Nothing in this "
            "process can resolve a tenant while that is true."
        ) from exc
    if not found:
        raise RuntimeRoleError(
            "all_tenant_ids() answered with no tenants at all, so the schema "
            "predates the migration that seeds tenant zero and nothing here "
            "can be scoped to a tenant."
        )


async def _refuse_public_execute(connection: AsyncConnection) -> None:
    """The exemption must be the runtime role's, not everybody's.

    `EXECUTE` on a new function is granted to `PUBLIC`, so the lookups arrive
    callable by every role that can connect — including one created later for
    reporting, for a migration tool, or for a person. None of them can read a
    row of a scoped table, which is the boundary that matters, and all of them
    could enumerate the tenants and resolve any identifier they hold to one
    (`db/tenant_lookup.py` states exactly what that discloses). `boot`'s own
    `grant_runtime_role` closes it; this is the check that it did, and that
    nothing has re-granted it since — a `GRANT EXECUTE ON ALL FUNCTIONS IN
    SCHEMA public TO PUBLIC` issued to fix some unrelated permission error
    would reopen it in one statement and leave every other check here passing.

    `has_function_privilege('public', …)` is the pseudo-role spelling, which
    the access-privilege inquiry functions accept in place of a role name.
    Asked of the function's oid rather than its signature so a lookup that is
    not installed at all is absent from the result instead of raising —
    `_require_the_lookups` above is the check that says so, and it has already
    run by the time this one does.
    """
    expected = sorted(lookup.name for lookup in TENANT_LOOKUPS)
    rows = await connection.execute(
        text(
            """
            SELECT p.proname
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = ANY(:names)
              AND has_function_privilege('public', p.oid, 'EXECUTE')
            ORDER BY p.proname
            """
        ),
        {"names": expected},
    )
    public = [row[0] for row in rows]
    if public:
        raise RuntimeRoleError(
            f"PUBLIC holds EXECUTE on {public}, so every role with CONNECT on "
            "this database can call the tenant lookups (db/tenant_lookup.py) "
            "— enumerate every tenant, and resolve any user, credential, "
            "client, room, bridge or connector it can name to the tenant that "
            "owns it. That is the default a CREATE FUNCTION leaves behind, so "
            "either the boot grants have never run against this database "
            "(configure DB_OWNER_USER / DB_OWNER_PASSWORD) or something has "
            "granted EXECUTE back to PUBLIC since. Revoke it: REVOKE EXECUTE "
            "ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, then grant it to "
            "the runtime role by name."
        )


def _sqlstate(exc: DBAPIError) -> str | None:
    """The SQLSTATE behind a driver error, however this driver spells it.

    asyncpg exposes `sqlstate`; SQLAlchemy's own wrapper exposes `pgcode` on
    some drivers. Reading both rather than one keeps the check from silently
    degrading into "any error will do" if the driver ever changes.
    """
    original = exc.orig
    for attribute in ("sqlstate", "pgcode"):
        value = getattr(original, attribute, None)
        if value is not None:
            return str(value)
    return None
