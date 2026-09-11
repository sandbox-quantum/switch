"""The boot self-check: does this connection actually have the policies on it.

`db/runtime_role.verify_restricted_role` is the answer to a failure that is
otherwise silent and that CI cannot ask about — CI has no production
connection, and a Switch that believes it is isolating tenants and is not
looks exactly like one that is. What CI *can* do is prove the check itself
works: that it passes for a role the policies apply to, and refuses for each
of the shapes that would make them inert.

The `rls_harness` fixture already builds both ends of that — the container's
superuser, which owns the schema, and a throwaway role that is neither owner
nor superuser and is granted by the same `grant_runtime_role` a deployment
runs at boot. So each test here is a connection handed to the check.

`tenants` is populated throughout, and that is not incidental. Postgres does
not evaluate a policy for a scan that yields no rows, so the behavioural probe
— the only part of the check that observes rather than infers — needs a row to
be meaningful at all. The fixture seeds tenant zero, and one test below pins
what happens when nothing has.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.runtime_role import (
    RuntimeRoleError,
    _refuse_a_connection_no_policy_stops,
    _refuse_table_owner,
    grant_runtime_role,
    verify_restricted_role,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


class TestItPassesForARoleThePoliciesApplyTo:
    async def test_the_restricted_role_is_accepted(
        self, rls_harness: RLSHarness
    ) -> None:
        await verify_restricted_role(rls_harness.restricted_engine)

    async def test_that_role_can_still_do_ordinary_work(
        self, rls_harness: RLSHarness
    ) -> None:
        """The other half of "accepted": a check that passed for a role too
        restricted to serve a request would be worse than no check at all,
        since boot would then succeed and the first query would fail. The
        grants come from `grant_runtime_role`, the same function a deployment
        runs, so this is a statement about production and not about a fixture.

        Two tenants, and a row in each, so the count at the end says something.
        Against one tenant on a fresh schema `count(*) == 1` is satisfied by a
        database with no policies in it at all — it would prove the grants and
        nothing else, which is not what the name claims. With a second
        tenant's row present, the same 1 is the policy filtering.
        """
        mine = f"tenant-{uuid.uuid4().hex[:8]}"
        theirs = f"tenant-{uuid.uuid4().hex[:8]}"
        async with rls_harness.owner() as session:
            for tenant_id in (mine, theirs):
                await session.execute(
                    text("INSERT INTO tenants (id, slug, name) VALUES (:id, :id, :id)"),
                    {"id": tenant_id},
                )
            await session.execute(
                text(
                    "INSERT INTO room_groups (id, tenant_id, name) "
                    "VALUES (:id, :t, 'somebody else')"
                ),
                {"id": str(uuid.uuid4()), "t": theirs},
            )
            await session.commit()

        async with rls_harness.restricted() as session:
            await session.execute(
                text("SELECT set_config('app.tenant_id', :t, true)"),
                {"t": mine},
            )
            await session.execute(
                text(
                    "INSERT INTO room_groups (id, tenant_id, name) "
                    "VALUES (:id, :t, 'a group')"
                ),
                {"id": str(uuid.uuid4()), "t": mine},
            )
            visible = (
                await session.execute(text("SELECT count(*) FROM room_groups"))
            ).scalar_one()
            await session.commit()
        assert visible == 1, (
            "the restricted role saw a row it does not own, so it can read and "
            "write but is not actually scoped"
        )


class TestItRefusesEveryShapeThatWouldMakeThePoliciesInert:
    async def test_a_superuser_is_refused(self, rls_harness: RLSHarness) -> None:
        """The container's own role, which is what local Compose, the chart
        and every environment used before this change connected as."""
        with pytest.raises(RuntimeRoleError) as raised:
            await verify_restricted_role(rls_harness.owner_engine)
        assert "superuser or carries BYPASSRLS" in str(raised.value)

    async def test_owning_a_policied_table_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """Asked of the ownership check directly, because the connection that
        owns these tables here is also a superuser and the check above would
        refuse it first. Ownership is the subtler of the two and the one a
        real deployment is far more likely to hit: a role created by hand, not
        a superuser, given the schema because that was the easy way to make
        migrations work.
        """
        async with rls_harness.owner_engine.connect() as connection:
            role = str(
                (await connection.execute(text("SELECT current_user"))).scalar_one()
            )
            with pytest.raises(RuntimeRoleError) as raised:
                await _refuse_table_owner(connection, role)
        assert "owns" in str(raised.value)
        assert "exempts a table's owner" in str(raised.value)

    async def test_forcing_row_level_security_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """`force row level security` sounds like more isolation and is less.

        It takes the ownership exemption away from the schema owner, and the
        seven tenant lookups (`db/tenant_lookup.py`) are `SECURITY DEFINER`
        functions running as exactly that owner. Force it and nothing in the
        process can answer "which tenant is this credential in", so no request
        authenticates — a total outage arriving as a wall of 401s. Boot says
        so instead.
        """
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text("ALTER TABLE tenants FORCE ROW LEVEL SECURITY")
            )
        with pytest.raises(RuntimeRoleError) as raised:
            await verify_restricted_role(rls_harness.restricted_engine)
        assert "FORCE ROW LEVEL SECURITY" in str(raised.value)

    async def test_a_connection_no_policy_stops_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """The behavioural probe, asked of a connection that is exempt.

        This is the check that would catch an exemption the catalogue
        questions did not think to look for, so it is worth exercising against
        something genuinely exempt rather than trusting that it would. The
        owner reads `tenants` with nothing bound and gets rows; the probe
        refuses on the count rather than on why.
        """
        async with rls_harness.owner_engine.connect() as connection:
            with pytest.raises(RuntimeRoleError) as raised:
                await _refuse_a_connection_no_policy_stops(connection, "owner")
        assert "instead of raising" in str(raised.value)

    async def test_an_ungranted_role_is_refused_rather_than_mistaken_for_isolated(
        self, rls_harness: RLSHarness, postgres_url: str
    ) -> None:
        """The trap in the probe, and why it matches the message and not just
        the SQLSTATE.

        `require_tenant_id()` raises 42501, `insufficient_privilege`. So does
        `permission denied for table tenants`. A role that had never been
        granted anything would therefore fail the probe's read for an entirely
        unrelated reason, and a check keyed on the code alone would read that
        as "the policy refused it" and let boot proceed on a connection that
        cannot serve a single request.

        Two assertions, because two checks now stand between such a role and
        the probe. `verify_restricted_role` refuses it earlier and more
        precisely: the lookups are no longer `PUBLIC`-executable, so a role
        that was granted nothing cannot call them, and boot says *that* rather
        than reporting a suspicious read. The probe is then asked directly on
        the same connection, because the trap it guards against is a property
        of the probe rather than of the order the checks happen to run in —
        and the order is exactly the sort of thing a later edit changes.
        """
        role = f"switch_ungranted_{uuid.uuid4().hex[:12]}"
        password = uuid.uuid4().hex
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text(
                    f"CREATE ROLE \"{role}\" LOGIN PASSWORD '{password}' "
                    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                )
            )
            await connection.execute(text(f'GRANT USAGE ON SCHEMA public TO "{role}"'))
        engine = create_async_engine(
            make_url(postgres_url).set(username=role, password=password)
        )
        try:
            with pytest.raises(RuntimeRoleError) as raised:
                await verify_restricted_role(engine)
            assert "cannot execute" in str(raised.value)

            async with engine.connect() as connection:
                with pytest.raises(RuntimeRoleError) as probed:
                    await _refuse_a_connection_no_policy_stops(connection, role)
            assert "not with 42501" in str(probed.value)
            assert "missing its grants" in str(probed.value)
        finally:
            await engine.dispose()
            async with rls_harness.owner_engine.begin() as connection:
                await connection.execute(text(f'DROP OWNED BY "{role}"'))
                await connection.execute(text(f'DROP ROLE "{role}"'))

    async def test_a_role_that_cannot_run_the_lookups_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """A role granted its tables but not the exemption would pass every
        check above and then fail to authenticate anybody, because every
        credential resolution goes through one of those functions. Boot says
        which ones rather than leaving it to a wall of 401s.
        """
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text("REVOKE EXECUTE ON FUNCTION all_tenant_ids() FROM PUBLIC")
            )
            await connection.execute(
                text(
                    "REVOKE EXECUTE ON FUNCTION all_tenant_ids() FROM "
                    + await _current_restricted_role(rls_harness)
                )
            )
        with pytest.raises(RuntimeRoleError) as raised:
            await verify_restricted_role(rls_harness.restricted_engine)
        assert "cannot execute" in str(raised.value)
        assert "all_tenant_ids" in str(raised.value)


class TestTheExemptionBelongsToTheRuntimeRoleAndNotToEverybody:
    """`EXECUTE` on a new function is granted to `PUBLIC`, and these are new
    functions.

    Left at that default the tenant lookups are callable by every role with
    `CONNECT` on the database — a reporting role, a migration tool's role, a
    person's. None of them can read a row of a scoped table, which is the
    boundary that matters, but all of them could enumerate the deployment's
    tenants and resolve any identifier they hold to one. `grant_runtime_role`
    closes it and the self-check refuses to serve if it reopens.
    """

    async def test_a_second_role_with_connect_cannot_call_a_lookup(
        self, rls_harness: RLSHarness, postgres_url: str
    ) -> None:
        """The property itself, measured rather than read off the catalogue.

        A role created after `grant_runtime_role` has run, given nothing but
        the `USAGE` any role needs to see the schema at all, tries the
        enumeration and is refused. Asked of a *second* role because the
        runtime role must still be able to call it, and a check that looked
        only at one of them could pass by breaking the wrong thing.
        """
        role = f"switch_bystander_{uuid.uuid4().hex[:12]}"
        password = uuid.uuid4().hex
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text(
                    f"CREATE ROLE \"{role}\" LOGIN PASSWORD '{password}' "
                    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                )
            )
            await connection.execute(text(f'GRANT USAGE ON SCHEMA public TO "{role}"'))
        engine = create_async_engine(
            make_url(postgres_url).set(username=role, password=password)
        )
        try:
            async with engine.connect() as connection:
                with pytest.raises(DBAPIError) as raised:
                    await connection.execute(
                        text("SELECT count(*) FROM all_tenant_ids()")
                    )
            assert "permission denied for function all_tenant_ids" in str(raised.value)

            # And the runtime role still can, which is the half that makes the
            # refusal above a boundary rather than a broken schema.
            async with rls_harness.restricted_engine.connect() as connection:
                assert (
                    await connection.execute(
                        text("SELECT count(*) FROM all_tenant_ids()")
                    )
                ).scalar_one() >= 1
        finally:
            await engine.dispose()
            async with rls_harness.owner_engine.begin() as connection:
                await connection.execute(text(f'DROP OWNED BY "{role}"'))
                await connection.execute(text(f'DROP ROLE "{role}"'))

    async def test_a_function_created_after_the_grants_is_not_public_executable(
        self, rls_harness: RLSHarness
    ) -> None:
        """The gap between one boot and the next.

        A revision adding an eighth lookup creates it `PUBLIC`-executable, and
        the boot that would revoke that has not happened yet. The default
        privileges cover the window — and they only do so because the revoke
        is issued without `IN SCHEMA`: a per-schema default ACL is unioned
        with the built-in one rather than replacing it, so the schema-scoped
        spelling records nothing and the new function arrives
        `PUBLIC`-executable regardless. Measured here, because that is not
        something to take on trust from a statement that reports success.
        """
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE FUNCTION tenant_of_something_new(p_id text) "
                    "RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER "
                    "SET search_path = pg_catalog, public, pg_temp "
                    "AS $$SELECT id FROM tenants WHERE id = p_id$$"
                )
            )
        try:
            async with rls_harness.restricted_engine.connect() as connection:
                public_may, runtime_may = (
                    await connection.execute(
                        text(
                            "SELECT has_function_privilege("
                            "  'public', 'tenant_of_something_new(text)', 'EXECUTE'), "
                            "has_function_privilege("
                            "  current_user, 'tenant_of_something_new(text)', 'EXECUTE')"
                        )
                    )
                ).one()
            assert not public_may, (
                "a function created between two boots is PUBLIC-executable, so "
                "an eighth lookup would be open to every role until the next "
                "restart revoked it"
            )
            assert runtime_may, (
                "the default privileges revoked PUBLIC's EXECUTE and did not "
                "grant the runtime role's, so a new function would be callable "
                "by nobody until the next boot"
            )
        finally:
            async with rls_harness.owner_engine.begin() as connection:
                await connection.execute(
                    text("DROP FUNCTION tenant_of_something_new(text)")
                )

    async def test_granting_execute_back_to_public_is_refused_at_boot(
        self, rls_harness: RLSHarness
    ) -> None:
        """One statement reopens it, and every other check here still passes.

        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC` is the sort
        of thing issued to clear an unrelated permission error. The role stays
        restricted, owns nothing, forces nothing, and the unbound read of
        `tenants` still raises — so nothing but this check would notice.
        """
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(
                text("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC")
            )
        with pytest.raises(RuntimeRoleError) as raised:
            await verify_restricted_role(rls_harness.restricted_engine)
        assert "PUBLIC holds EXECUTE" in str(raised.value)
        assert "all_tenant_ids" in str(raised.value)


class TestTheProbeIsOnlyMeaningfulAgainstARow:
    async def test_an_empty_tenants_table_refuses_rather_than_passing(
        self, rls_harness: RLSHarness
    ) -> None:
        """The data-dependence of the whole approach, pinned.

        Postgres does not evaluate a policy for a scan that finds no rows, so
        against an empty `tenants` the probe's read succeeds and returns zero
        — a result indistinguishable from a database with no policies in it.
        Boot must not read that as a pass, and it does not: the empty table is
        caught one check earlier, by the one that insists `all_tenant_ids()`
        answers with something, which names the cause instead of leaving the
        probe to report a suspicious zero. Either way the answer is the same
        and it is the right way round — a deployment whose `tenants` table is
        empty has no tenant zero and is broken regardless, and refusing to
        boot says so rather than serving with isolation nobody has checked.
        """
        async with rls_harness.owner_engine.begin() as connection:
            await connection.execute(text("DELETE FROM tenants"))
        with pytest.raises(RuntimeRoleError) as raised:
            await verify_restricted_role(rls_harness.restricted_engine)
        assert "answered with no tenants at all" in str(raised.value)


async def _current_restricted_role(harness: RLSHarness) -> str:
    async with harness.restricted_engine.connect() as connection:
        role = str((await connection.execute(text("SELECT current_user"))).scalar_one())
    async with harness.owner_engine.connect() as connection:
        return str(
            (
                await connection.execute(
                    text("SELECT quote_ident(:name)"), {"name": role}
                )
            ).scalar_one()
        )


async def test_the_grants_are_reissued_idempotently(
    rls_harness: RLSHarness,
) -> None:
    """Boot re-runs the grants on every start, after the migration that may
    have added a table. Running them twice has to be a no-op rather than an
    error, or the second boot of an unchanged deployment fails."""
    async with rls_harness.restricted_engine.connect() as connection:
        role = str((await connection.execute(text("SELECT current_user"))).scalar_one())
    async with rls_harness.owner_engine.begin() as connection:
        await grant_runtime_role(connection, role)
        await grant_runtime_role(connection, role)
    await verify_restricted_role(rls_harness.restricted_engine)
