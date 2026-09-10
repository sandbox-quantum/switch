"""The exemption from row-level security, asked of a role the policies apply to.

Everything here runs against `rls_harness.restricted`, never `session_factory`
or `rls_harness.owner`. That is not a preference: the owner is exempt from
every policy in this schema by ownership, so a test of the exemption asked of
the owner passes whether or not the exemption exists.

**Every arrangement leaves the table it reads populated.** Postgres does not
evaluate a policy for a scan that yields no rows, so a "the policy refuses
this" assertion against an empty table is satisfied by a database with no
policies in it at all. Two of the nineteen call sites this exemption was built
for were invisible for exactly that reason — they returned nothing, silently,
until a row existed — so the rule is written down here rather than left to
whoever adds the next test.

Four things are pinned:

- **the catalogue**: the functions installed are exactly `TENANT_LOOKUPS`, and
  each one is `SECURITY DEFINER`, `STABLE`, and carries a search path that a
  temporary table cannot shadow;
- **the behaviour**: each answers correctly for the restricted role, against
  two tenants, where the equivalent ordinary read answers nothing;
- **the boundary**: they return tenant ids and never rows, and the tables they
  read are still refused to the same role in the same session;
- **the constraint they rest on**: no scoped table has `force row level
  security`, which would take the ownership exemption away from them and leave
  nothing in the process able to resolve a credential.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from types import ModuleType

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import switch_core
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    Room,
    ServerConnector,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.tenant_lookup import (
    SECURE_SEARCH_PATH,
    TENANT_LOOKUPS,
    TenantLookupError,
    all_tenant_ids,
    create_lookup_ddl,
    tenant_of_agent_oauth_client,
    tenant_of_api_key,
    tenant_of_client,
    tenant_of_collaboration_bridge,
    tenant_of_room,
    tenant_of_server_connector,
    tenants_of_user,
)
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

# The revision that installs the exemption for a database built by Alembic.
_LOOKUP_REVISION = "9c41a7b0e5d8"


def _migration_module() -> ModuleType:
    """The `9c41a7b0e5d8` revision module, loaded through Alembic.

    Alembic's own loader rather than an `importlib` call on a path, so this
    finds the file the same way a deployment would and fails the same way if
    the revision were renamed or removed.
    """
    core = Path(switch_core.__file__).resolve().parents[1]
    config = Config(str(core / "alembic.ini"))
    config.set_main_option("script_location", str(core / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config).get_revision(_LOOKUP_REVISION).module


class _Fixture:
    """The ids two populated tenants leave behind, for the assertions below."""

    def __init__(self) -> None:
        self.tenant_a: str = ""
        self.tenant_b: str = ""
        self.client_a: str = ""
        self.room_a: str = ""
        self.bridge_a: str = ""
        self.connector_a: str = ""
        self.key_hash_a: str = ""
        self.oauth_client_a: str = ""
        self.user_a: str = ""
        self.user_in_both: str = ""


async def _two_populated_tenants(harness: RLSHarness) -> _Fixture:
    """Two tenants, each with a full set of the rows the lookups read.

    Both tenants are populated rather than just the one under test, because
    the question every lookup answers is "which of them", and a single-tenant
    arrangement cannot tell a correct answer apart from the only answer
    available. Written through the owner: creating a second `tenants` row is
    necessarily a system operation, since that table's policy compares on `id`
    and no session can be bound to two tenants at once.
    """
    fixture = _Fixture()
    suffix = uuid.uuid4().hex[:8]
    fixture.tenant_a = f"tenant-a-{suffix}"
    fixture.tenant_b = f"tenant-b-{suffix}"
    fixture.oauth_client_a = f"oauth-{suffix}"
    fixture.key_hash_a = f"hash-a-{suffix}"

    async with harness.owner() as session:
        for tenant_id in (fixture.tenant_a, fixture.tenant_b):
            session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()

        user_a = User(name="A", email=f"a-{suffix}@example.test", role="user")
        user_both = User(name="Both", email=f"both-{suffix}@example.test", role="user")
        session.add_all([user_a, user_both])
        await session.flush()
        fixture.user_a, fixture.user_in_both = user_a.id, user_both.id
        session.add_all(
            [
                TenantMember(
                    tenant_id=fixture.tenant_a, user_id=user_a.id, role="member"
                ),
                TenantMember(
                    tenant_id=fixture.tenant_a, user_id=user_both.id, role="member"
                ),
                TenantMember(
                    tenant_id=fixture.tenant_b, user_id=user_both.id, role="member"
                ),
            ]
        )

        for tenant_id, tag in ((fixture.tenant_a, "a"), (fixture.tenant_b, "b")):
            client = Client(
                tenant_id=tenant_id,
                matrix_user_id=f"@client-{tag}-{suffix}:test",
                display_name=f"client {tag}",
                type="agent",
            )
            room = Room(
                tenant_id=tenant_id,
                matrix_room_id=f"!room-{tag}-{suffix}:test",
                name=f"room {tag}",
                description="",
            )
            key = ApiKey(
                tenant_id=tenant_id,
                user_id=user_both.id,
                key_hash=f"hash-{tag}-{suffix}",
                encrypted_key="x",
                label=f"key {tag}",
                type="agent",
            )
            session.add_all([client, room, key])
            await session.flush()
            bridge = CollaborationBridge(
                tenant_id=tenant_id,
                type="slack",
                display_name=f"bridge {tag}",
                status="active",
                connection_config={},
                client_id=client.id,
            )
            connector = ServerConnector(
                tenant_id=tenant_id,
                type="opencode",
                display_name=f"connector {tag}",
                api_key_id=key.id,
                status="active",
                connection_config={},
            )
            session.add_all([bridge, connector])
            session.add(
                Agent(
                    tenant_id=tenant_id,
                    name=f"agent-{tag}-{suffix}",
                    description="",
                    owner_id=user_both.id,
                    client_id=client.id,
                    api_key_id=key.id,
                    agent_type="always_on",
                    integration_profile={"connection_model": "always_on"},
                    connector_type="test",
                    # Both tenants carry the same value on a column with no
                    # unique index: the one lookup that can legitimately
                    # answer twice, and the case it has to refuse.
                    oauth_client_id=fixture.oauth_client_a,
                )
            )
            await session.flush()
            if tag == "a":
                fixture.client_a = client.id
                fixture.room_a = room.id
                fixture.bridge_a = bridge.id
                fixture.connector_a = connector.id
        await session.commit()
    return fixture


class TestTheCatalogueIsWhatIsInstalled:
    async def test_every_lookup_exists_and_nothing_else_does(
        self, rls_harness: RLSHarness
    ) -> None:
        """The set of exempt functions in the database is exactly the list in
        `db/tenant_lookup.py`.

        Both directions matter, and the second more than the first: a
        `SECURITY DEFINER` function nobody has written down is an exemption
        nobody is auditing. `require_tenant_id` is the only other function
        here that is not one, and it is not `SECURITY DEFINER`, which is what
        this test keys on rather than a name.
        """
        async with rls_harness.restricted() as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT p.proname
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prosecdef
                        """
                    )
                )
            ).scalars()
            installed = set(rows)
        assert installed == {lookup.name for lookup in TENANT_LOOKUPS}

    async def test_each_one_is_stable_and_cannot_have_its_tables_shadowed(
        self, rls_harness: RLSHarness
    ) -> None:
        """`STABLE` so the planner evaluates it once rather than per row, and
        a `search_path` with `pg_temp` last so a role able to create a
        temporary table cannot put its own `tenants` in front of the real one
        and have a function running as the owner read it."""
        async with rls_harness.restricted() as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT p.proname, p.provolatile::text, p.proconfig
                        FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prosecdef
                        """
                    )
                )
            ).all()
        assert rows
        for name, volatility, config in rows:
            assert volatility == "s", f"{name} is not STABLE"
            assert config is not None, f"{name} sets no search_path"
            paths = [entry for entry in config if entry.startswith("search_path=")]
            assert paths, f"{name} sets no search_path: {config}"
            assert paths[0].endswith("pg_temp"), (
                f"{name} does not put pg_temp last in its search_path: {paths[0]}"
            )

    async def test_no_scoped_table_forces_row_level_security(
        self, rls_harness: RLSHarness
    ) -> None:
        """The constraint the whole exemption rests on.

        `SECURITY DEFINER` is only half of why these functions can read across
        tenants: the other half is that they run as the schema owner, and
        Postgres exempts an owner from its own tables' policies *unless* the
        table sets `force row level security`. Setting it anywhere would leave
        nothing in the process able to answer "which tenant is this
        credential in", so every request would fail to authenticate. Boot
        refuses to start for the same reason (`db/runtime_role.py`); this
        catches it in CI, where the schema is actually built.
        """
        async with rls_harness.restricted() as session:
            forced = (
                await session.execute(
                    text(
                        """
                        SELECT c.relname
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relforcerowsecurity
                        """
                    )
                )
            ).scalars()
        assert list(forced) == []


class TestWhatTheyAnswer:
    async def test_all_tenant_ids_sees_every_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        found = await all_tenant_ids(rls_harness.restricted)
        assert {fixture.tenant_a, fixture.tenant_b} <= set(found)

    async def test_the_same_question_asked_the_ordinary_way_sees_one_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        """The measurement that makes the previous test mean something.

        `tenants` carries the same policy as everything else, comparing on
        `id`, so a session bound to a tenant sees exactly its own row — and
        one bound to nothing sees an error rather than every row. Both are
        asserted here so the exemption is measured against the behaviour it
        exists to work around, rather than against nothing.
        """
        fixture = await _two_populated_tenants(rls_harness)
        with tenant_scope(fixture.tenant_a):
            async with rls_harness.restricted() as session:
                visible = (
                    await session.execute(text("SELECT id FROM tenants"))
                ).scalars()
                assert list(visible) == [fixture.tenant_a]

        async with rls_harness.restricted() as session:
            with pytest.raises(DBAPIError) as raised:
                await session.execute(text("SELECT id FROM tenants"))
        assert "app.tenant_id is not set" in str(raised.value)

    async def test_a_membership_resolves_to_its_tenants(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        assert await tenants_of_user(rls_harness.restricted, fixture.user_a) == [
            fixture.tenant_a
        ]
        assert sorted(
            await tenants_of_user(rls_harness.restricted, fixture.user_in_both)
        ) == sorted([fixture.tenant_a, fixture.tenant_b])

    async def test_an_api_key_hash_resolves_to_its_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        suffix = fixture.key_hash_a.rsplit("-", 1)[-1]
        assert (
            await tenant_of_api_key(rls_harness.restricted, f"hash-a-{suffix}")
            == fixture.tenant_a
        )
        assert (
            await tenant_of_api_key(rls_harness.restricted, f"hash-b-{suffix}")
            == fixture.tenant_b
        )

    async def test_an_unknown_key_resolves_to_nothing_rather_than_raising(
        self, rls_harness: RLSHarness
    ) -> None:
        """An unrecognised bearer token is a 401, not a 500. The middleware
        stops here and never issues the second, scoped query, which is also
        what keeps an unauthenticated flood to one round trip."""
        await _two_populated_tenants(rls_harness)
        assert await tenant_of_api_key(rls_harness.restricted, "no-such-hash") is None

    async def test_a_client_room_bridge_and_connector_resolve_to_their_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        restricted = rls_harness.restricted
        assert await tenant_of_client(restricted, fixture.client_a) == fixture.tenant_a
        assert await tenant_of_room(restricted, fixture.room_a) == fixture.tenant_a
        assert (
            await tenant_of_collaboration_bridge(restricted, fixture.bridge_a)
            == fixture.tenant_a
        )
        assert (
            await tenant_of_server_connector(restricted, fixture.connector_a)
            == fixture.tenant_a
        )

    async def test_an_ambiguous_answer_is_refused_rather_than_picked(
        self, rls_harness: RLSHarness
    ) -> None:
        """`agents.oauth_client_id` carries no unique index, so two tenants
        can register an agent under the same one. Resolving that to a tenant
        by taking the first row would authenticate a caller into somebody
        else's data on the strength of a duplicate — a provisioning fault
        turned into an authorization one — so it raises."""
        fixture = await _two_populated_tenants(rls_harness)
        with pytest.raises(TenantLookupError) as raised:
            await tenant_of_agent_oauth_client(
                rls_harness.restricted, fixture.oauth_client_a
            )
        assert "refusing to pick one" in str(raised.value)


class TestTheBoundary:
    async def test_a_lookup_leaves_the_tables_it_read_still_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """The exemption is the function, not the caller and not the session.

        A caller that has just learned a tenant id from `tenant_of_api_key`
        has learned exactly that, and reading the row it named still needs the
        tenant bound. Asserted in the same session so there is no question of
        a different connection answering.
        """
        fixture = await _two_populated_tenants(rls_harness)
        suffix = fixture.key_hash_a.rsplit("-", 1)[-1]
        assert (
            await tenant_of_api_key(rls_harness.restricted, f"hash-a-{suffix}")
            == fixture.tenant_a
        )
        async with rls_harness.restricted() as session:
            assert (
                await session.execute(text("SELECT count(*) FROM all_tenant_ids()"))
            ).scalar_one() >= 2
            with pytest.raises(DBAPIError) as raised:
                await session.execute(text("SELECT id FROM api_keys"))
        assert "app.tenant_id is not set" in str(raised.value)

    async def test_a_lookup_does_not_inherit_the_callers_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        """Reached from inside a bound context — a gateway request resolving a
        bridge's tenant, say — the answer is still the row's own. The wrapper
        unbinds for its own session precisely so that the enumeration is not
        silently narrowed to whoever asked."""
        fixture = await _two_populated_tenants(rls_harness)
        with tenant_scope(fixture.tenant_a):
            found = await all_tenant_ids(rls_harness.restricted)
            assert (
                await tenant_of_room(rls_harness.restricted, fixture.room_a)
                == fixture.tenant_a
            )
        assert {fixture.tenant_a, fixture.tenant_b} <= set(found)

    async def test_the_callers_binding_survives_a_lookup(
        self, rls_harness: RLSHarness
    ) -> None:
        """Unbinding for the lookup must not unbind the caller. A request that
        resolved something mid-flight and then found its own tenant gone would
        fail on its next scoped read, which is a worse bug than the one the
        unbinding prevents."""
        fixture = await _two_populated_tenants(rls_harness)
        with tenant_scope(fixture.tenant_a):
            await all_tenant_ids(rls_harness.restricted)
            async with rls_harness.restricted() as session:
                still_visible = (
                    await session.execute(text("SELECT id FROM tenants"))
                ).scalars()
                assert list(still_visible) == [fixture.tenant_a]


class TestTheMigrationInstallsTheSameThing:
    """A frozen copy is the right shape for a migration — it must not change
    meaning because a module later does — and its failure mode is falling
    behind in silence: the schema `create_all` builds gets the live module's
    functions, so every test above passes, while a deployment built by Alembic
    gets whatever the migration froze.
    """

    def test_the_frozen_list_matches_the_live_one(self) -> None:
        module = _migration_module()
        assert module.SECURE_SEARCH_PATH == SECURE_SEARCH_PATH
        frozen = {
            (name, parameters, signature, body)
            for name, parameters, signature, body in module.LOOKUPS
        }
        live = {
            (
                lookup.name,
                "" if lookup.parameter is None else f"{lookup.parameter} text",
                lookup.signature,
                lookup.query,
            )
            for lookup in TENANT_LOOKUPS
        }
        assert frozen == live, (
            "the frozen LOOKUPS in migration 9c41a7b0e5d8 no longer match "
            "db/tenant_lookup.py. A deployment built by Alembic would get the "
            "migration's functions and every test above would still pass "
            "against create_all's. If the divergence is deliberate, express "
            "it as a new migration rather than by editing this one."
        )

    def test_the_statement_it_would_run_is_the_statement_the_module_builds(
        self,
    ) -> None:
        """The list agreeing is not enough: the template matters too.

        A frozen copy naming every function and every body correctly could
        still say `SECURITY INVOKER`, or drop the `search_path`, and the check
        above would pass. Nothing else would catch it — this suite builds its
        schema from the models, so the migration's own DDL is never executed
        here, and an Alembic-built database would install eight functions
        unable to resolve a tenant with the whole suite green. So what is
        compared is the rendered statement, not the inputs to it.
        """
        module = _migration_module()
        for lookup in TENANT_LOOKUPS:
            parameters = "" if lookup.parameter is None else f"{lookup.parameter} text"
            assert module.create_lookup_ddl(
                lookup.name, parameters, lookup.query
            ) == create_lookup_ddl(lookup), (
                f"migration 9c41a7b0e5d8 would install {lookup.name} with "
                "different DDL from the one db/tenant_lookup.py builds."
            )
