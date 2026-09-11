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

Five things are pinned:

- **the catalogue**: the functions installed are exactly `TENANT_LOOKUPS`, and
  each one is `SECURITY DEFINER`, `STABLE`, and carries a search path that a
  temporary table cannot shadow;
- **the behaviour**: each answers correctly for the restricted role, against
  two tenants, where the equivalent ordinary read answers nothing;
- **the boundary**: they return tenant ids and never rows, and the tables they
  read are still refused to the same role in the same session;
- **what that boundary does not cover**: `users` carries no tenant and so no
  policy, which makes the whole user-to-tenant membership graph readable with
  nothing bound. Written down as a deliberate property rather than left to be
  found, because the shorter statement of the boundary — "the tenant of an
  identifier you already hold" — reads as though it were covered;
- **the constraint they rest on**: no scoped table has `force row level
  security`, which would take the ownership exemption away from them and leave
  nothing in the process able to resolve a credential.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
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
    Invitation,
    Room,
    ServerConnector,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.tenant_lookup import (
    SECURE_SEARCH_PATH,
    TENANT_LOOKUPS,
    TENANT_LOOKUPS_BY_NAME,
    TenantLookupError,
    all_tenant_ids,
    create_lookup_ddl,
    tenant_of_agent_oauth_client,
    tenant_of_api_key,
    tenant_of_collaboration_bridge,
    tenant_of_invitation,
    tenant_of_room,
    tenant_of_server_connector,
    tenants_of_user,
)
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

# The revision that installs the exemption for a database built by Alembic.
_LOOKUP_REVISION = "9c41a7b0e5d8"

# What a later revision took back out, and which one did it. A migration is
# a record of a change that already happened, so `9c41a7b0e5d8` still names
# every function it created; the live module names what the schema holds
# today. The two agree only once the drops between them are accounted for,
# and naming the revision here is what keeps 'we removed it from the module'
# from passing as 'we removed it from the database'.
_DROPPED_SINCE = {"tenant_of_client": "b1d7c4f0a92e"}

# The same bookkeeping in the other direction: a lookup the live module names
# that `9c41a7b0e5d8` never created, and the revision that did create it. The
# frozen-copy comparison below has to know about both to stay exact — without
# this entry the only way to keep it green would be to loosen it to a subset
# check, and a subset check passes for a lookup that exists in the module and
# in no migration at all, which is a deployment whose invitation acceptance
# cannot resolve a tenant with the whole suite green.
_ADDED_SINCE = {"tenant_of_invitation": "5daaea6b674d"}


def _revision_module(revision: str) -> ModuleType:
    """One revision module, loaded through Alembic.

    Alembic's own loader rather than an `importlib` call on a path, so this
    finds the file the same way a deployment would and fails the same way if
    the revision were renamed or removed.
    """
    core = Path(switch_core.__file__).resolve().parents[1]
    config = Config(str(core / "alembic.ini"))
    config.set_main_option("script_location", str(core / "switch_core" / "migrations"))
    return ScriptDirectory.from_config(config).get_revision(revision).module


def _migration_module() -> ModuleType:
    """The revision that installed the exemption."""
    return _revision_module(_LOOKUP_REVISION)


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
        self.invitation_token_hash_a: str = ""
        self.invitation_token_hash_b: str = ""


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
            invitation = Invitation(
                tenant_id=tenant_id,
                role="member",
                email=None,
                token_hash=f"invitation-hash-{tag}-{suffix}",
                expires_at=datetime.now(UTC) + timedelta(days=1),
                uses_remaining=1,
                created_by=user_both.id,
            )
            session.add(invitation)
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
                fixture.invitation_token_hash_a = invitation.token_hash
            else:
                fixture.invitation_token_hash_b = invitation.token_hash
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

    async def test_a_room_bridge_and_connector_resolve_to_their_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        restricted = rls_harness.restricted
        assert await tenant_of_room(restricted, fixture.room_a) == fixture.tenant_a
        assert (
            await tenant_of_collaboration_bridge(restricted, fixture.bridge_a)
            == fixture.tenant_a
        )
        assert (
            await tenant_of_server_connector(restricted, fixture.connector_a)
            == fixture.tenant_a
        )

    async def test_an_invitation_token_hash_resolves_to_its_tenant(
        self, rls_harness: RLSHarness
    ) -> None:
        fixture = await _two_populated_tenants(rls_harness)
        assert (
            await tenant_of_invitation(
                rls_harness.restricted, fixture.invitation_token_hash_a
            )
            == fixture.tenant_a
        )
        assert (
            await tenant_of_invitation(
                rls_harness.restricted, fixture.invitation_token_hash_b
            )
            == fixture.tenant_b
        )

    async def test_an_unknown_invitation_token_resolves_to_nothing(
        self, rls_harness: RLSHarness
    ) -> None:
        """An invitation link nobody minted is a 404, not a 500 — same shape
        as an unrecognised bearer token."""
        await _two_populated_tenants(rls_harness)
        assert (
            await tenant_of_invitation(rls_harness.restricted, "no-such-hash") is None
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


class TestWhatTheExemptionDiscloses:
    """The boundary is on rows, not on the shape of the deployment.

    `db/tenant_lookup.py` used to claim that the most a caller could extract
    was the tenant of an identifier it already held. That is false three ways,
    and the two that are closed are pinned elsewhere: `all_tenant_ids()` takes
    no identifier at all (`TestWhatTheyAnswer` above), and `PUBLIC` no longer
    holds `EXECUTE` (`test_runtime_role.py`). The third is not closed, and is
    pinned here as a deliberate property rather than left to be rediscovered
    as a surprise.
    """

    async def test_the_membership_graph_is_readable_with_nothing_bound(
        self, rls_harness: RLSHarness
    ) -> None:
        """`users` carries no tenant, so it carries no policy.

        A person is global — the per-tenant object is the `tenant_members`
        row — and `db/rls_ddl.py`'s `GLOBAL_TABLES` says so on purpose. The
        consequence is that a session with nothing bound reads every user id,
        and feeding those to `tenants_of_user` one at a time reconstructs the
        whole user-to-tenant membership graph. No row of a scoped table
        crosses a boundary doing it; what is disclosed is who exists and which
        tenants they belong to.

        Closing it means giving `users` a tenant, which it cannot have while a
        person may belong to more than one, or taking `tenants_of_user` out of
        the exemption, which is the read every gateway login depends on. So it
        stands, and it stands as something written down: anyone holding the
        runtime role's credentials can learn this, and that is the boundary
        this design draws rather than an oversight in it.
        """
        fixture = await _two_populated_tenants(rls_harness)

        async with rls_harness.restricted() as session:
            user_ids = [
                row[0] for row in await session.execute(text("SELECT id FROM users"))
            ]
        assert {fixture.user_a, fixture.user_in_both} <= set(user_ids)

        graph = {
            user_id: sorted(await tenants_of_user(rls_harness.restricted, user_id))
            for user_id in user_ids
        }
        assert graph[fixture.user_a] == [fixture.tenant_a]
        assert graph[fixture.user_in_both] == sorted(
            [fixture.tenant_a, fixture.tenant_b]
        )

    async def test_the_membership_rows_themselves_are_still_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        """The half that is closed, next to the half that is not.

        `tenant_members` is scoped, so the row — its role, when it was
        written, everything on it other than the pair of ids — is refused to
        the same session that just reconstructed the pairs. That is the
        difference between disclosing metadata and disclosing data, and it is
        the line the exemption actually holds.
        """
        await _two_populated_tenants(rls_harness)

        async with rls_harness.restricted() as session:
            with pytest.raises(DBAPIError) as raised:
                await session.execute(text("SELECT role FROM tenant_members"))
        assert "app.tenant_id is not set" in str(raised.value)


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
            if name not in _DROPPED_SINCE
        }
        live = {
            (
                lookup.name,
                "" if lookup.parameter is None else f"{lookup.parameter} text",
                lookup.signature,
                lookup.query,
            )
            for lookup in TENANT_LOOKUPS
            if lookup.name not in _ADDED_SINCE
        }
        assert frozen == live, (
            "the frozen LOOKUPS in migration 9c41a7b0e5d8 no longer match "
            "db/tenant_lookup.py. A deployment built by Alembic would get the "
            "migration's functions and every test above would still pass "
            "against create_all's. If the divergence is deliberate, express "
            "it as a new migration rather than by editing this one — and name "
            "the lookup in _DROPPED_SINCE or _ADDED_SINCE above, whichever "
            "the new migration does, so this comparison stays exact rather "
            "than being loosened."
        )

    def test_the_added_lookup_is_installed_by_a_revision_and_not_only_here(
        self,
    ) -> None:
        """The mirror of the dropped-lookup test, and the more dangerous half.

        A lookup added to `db/tenant_lookup.py` is built by `create_all`, so
        every test in this file exercises it and passes. A deployment's schema
        is built by Alembic, which knows nothing about it: the function is
        absent, and the first call — an invitation acceptance trying to
        resolve a tenant — fails at runtime in production and nowhere else.

        Comparing the rendered statement rather than the pieces, for the same
        reason the test below does: a revision that created the function
        `SECURITY INVOKER`, or without the `search_path`, would install
        something that cannot read across tenants at all.
        """
        revision = _ADDED_SINCE["tenant_of_invitation"]
        lookup = TENANT_LOOKUPS_BY_NAME["tenant_of_invitation"]
        module = _revision_module(revision)
        assert module.CREATE_TENANT_OF_INVITATION == create_lookup_ddl(lookup), (
            f"revision {revision} would install tenant_of_invitation with "
            "different DDL from the one db/tenant_lookup.py builds."
        )
        assert module.DROP_TENANT_OF_INVITATION == (
            f"DROP FUNCTION IF EXISTS {lookup.signature}"
        )

    def test_the_dropped_lookup_is_dropped_by_a_revision_and_not_only_here(
        self,
    ) -> None:
        """Removing a function from `db/tenant_lookup.py` removes it from what
        `create_all` builds and from nothing else.

        A deployment's schema is built by Alembic, so a lookup deleted from the
        module and left in the chain is still installed, still `SECURITY
        DEFINER`, and still answers — while every test in this file, which
        builds its schema from the models, agrees it is gone. That is the exact
        shape of failure the frozen-copy tests exist for, arrived at from the
        other direction.

        The downgrade is checked against `9c41a7b0e5d8`'s frozen text rather
        than against what the module would build, because the module no longer
        builds it at all: a rollback past this revision has to land on the
        schema the revision below it created.
        """
        installed = _migration_module()
        dropped = _revision_module(_DROPPED_SINCE["tenant_of_client"])
        assert (
            dropped.DROP_TENANT_OF_CLIENT
            == "DROP FUNCTION IF EXISTS tenant_of_client(text)"
        )
        frozen = {
            name: (parameters, body)
            for name, parameters, _signature, body in installed.LOOKUPS
        }
        parameters, body = frozen["tenant_of_client"]
        assert dropped.CREATE_TENANT_OF_CLIENT == installed.create_lookup_ddl(
            "tenant_of_client", parameters, body
        ), (
            "the downgrade would recreate tenant_of_client with different DDL "
            "from the one 9c41a7b0e5d8 installed, so a rollback past it lands "
            "on a schema that revision would not recognise."
        )

    def test_the_statement_it_would_run_is_the_statement_the_module_builds(
        self,
    ) -> None:
        """The list agreeing is not enough: the template matters too.

        A frozen copy naming every function and every body correctly could
        still say `SECURITY INVOKER`, or drop the `search_path`, and the check
        above would pass. Nothing else would catch it — this suite builds its
        schema from the models, so the migration's own DDL is never executed
        here, and an Alembic-built database would install functions
        unable to resolve a tenant with the whole suite green. So what is
        compared is the rendered statement, not the inputs to it.
        """
        module = _migration_module()
        for lookup in TENANT_LOOKUPS:
            if lookup.name in _ADDED_SINCE:
                continue
            parameters = "" if lookup.parameter is None else f"{lookup.parameter} text"
            assert module.create_lookup_ddl(
                lookup.name, parameters, lookup.query
            ) == create_lookup_ddl(lookup), (
                f"migration 9c41a7b0e5d8 would install {lookup.name} with "
                "different DDL from the one db/tenant_lookup.py builds."
            )
