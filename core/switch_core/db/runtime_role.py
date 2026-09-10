"""Making the policies bite: the restricted runtime role, and proving it is one.

Every policy in `db/rls_ddl.py` is inert against a superuser or a table owner
— Postgres exempts both, the first unconditionally and the second because this
design deliberately never sets `force row level security` (which is also what
lets the exempt lookups in `db/tenant_lookup.py` work at all). So the schema
half of tenant isolation is only worth what the connection is: a deployment
that installs 38 policies and then connects as the owner has none of them.

Two halves live here.

**Grants.** The runtime role owns nothing and can create nothing, so it needs
to be given access to every table the owner created. Re-issued on every boot,
immediately after the migration that may have added one, rather than once by
hand: `ALTER DEFAULT PRIVILEGES` covers a table created *later by the owner*
and is easy to get subtly wrong (it is per-granting-role, and silently does
nothing for objects an unnamed role creates), whereas a fresh `GRANT ... ON
ALL TABLES` after `alembic upgrade head` cannot fall behind the schema it was
just run against. It is idempotent and costs one round trip at boot.

**The self-check.** Four questions asked of the runtime connection before the
server listens, because this failure mode is silent and CI cannot ask it: CI
has no production connection, and a Switch that believes it is isolating
tenants and is not looks exactly like one that is. In order of how much they
prove:

1. The role is not a superuser and carries no `BYPASSRLS`, nor is it a member
   of a role that has either — membership is a `SET ROLE` away from both.
2. It owns none of the tables carrying a policy.
3. No scoped table has `force row level security`, which would take the
   ownership exemption away from the lookup functions and leave the process
   unable to resolve a credential at all.
4. Every tenant lookup exists and this role may execute it, since a role that
   cannot would authenticate nobody.
5. **A read of `tenants` with nothing bound raises.** This is the one that
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
    so a ninth lookup needs no change here.

    No `CREATE` on the schema, and no ownership: the role is meant to be
    unable to alter the tables it reads, which is what keeps it subject to
    their policies.
    """
    identifier = await _quoted_identifier(owner, role)
    for statement in (
        f"GRANT USAGE ON SCHEMA public TO {identifier}",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {identifier}",
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {identifier}",
        f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO {identifier}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {identifier}",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {identifier}",
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
        await _require_the_lookups(connection, role)
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
    result = await connection.execute(
        text(
            """
            SELECT c.relname
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relrowsecurity
              AND pg_get_userbyid(c.relowner) = current_user
            ORDER BY c.relname
            """
        )
    )
    owned = [row[0] for row in result]
    if owned:
        raise RuntimeRoleError(
            f"The database role {role!r} owns {len(owned)} of the tables "
            f"carrying a tenant-isolation policy (for example {owned[:3]}). "
            "Postgres exempts a table's owner from its own policies unless "
            "FORCE ROW LEVEL SECURITY is set, which this design deliberately "
            "does not set, so those policies do nothing on this connection. "
            "Run the service as a role that owns no table."
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
    found = (
        await connection.execute(text("SELECT count(*) FROM all_tenant_ids()"))
    ).scalar_one()
    if not found:
        raise RuntimeRoleError(
            "all_tenant_ids() answered with no tenants at all. Either the "
            "schema predates the migration that seeds tenant zero, or the "
            "function is not the SECURITY DEFINER one this process expects — "
            "either way nothing here can be scoped to a tenant."
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
