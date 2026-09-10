"""What `room_service.py`'s tenant bindings do, asked of Postgres (CHOO-2623).

`room_service.py` is the largest single piece of the tenant rework and it had
no test that could tell the rework from its absence. The proof was mechanical:
shadow `tenant_scope`, `tenant_session` and `unscoped_session` with no-ops
inside that one module and the whole suite still passed, 2833 to 2833. Not one
assertion anywhere depended on a single binding this file makes.

This module is built so that experiment fails. Two things make that possible
where the rest of the suite could not:

**It asks the database, not the service.** Every binding assertion here reads
``current_setting('app.tenant_id')`` on the very session the service handed the
store — the value ``db/tenant_session.py``'s ``after_begin`` hook wrote, which
is what the policies compare and what every scoped write is filed under. An
assertion about rows cannot see a missing binding while Switch runs as the
tables' owner, which is what Phase 1 deploys: Postgres exempts an owner from
its own policies, so a session that forgot its tenant reads and writes exactly
as much as one that remembered (the restricted runtime role is CHOO-2685).
The setting is the one thing that still differs.

**It uses two tenants.** Half of what these bindings are for only has an
observable effect once a second tenant owns something, which no other test in
the suite arranges.

`_TenantRecordingRoomStore` is a real `RoomStore` — the queries, the composite
foreign keys and the policies are all the production ones. It notes what
Postgres thought the tenant was, and delegates.
"""

from __future__ import annotations

import asyncio
import inspect
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.exc import StatementError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    Room,
    Tenant,
    TenantNotBoundError,
    User,
    room_agents,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.tenant_store import TenantStore
from switch_core.room_service import RoomService
from switch_core.tenant_context import current_tenant_id, tenant_scope

pytestmark = pytest.mark.no_ambient_tenant

TENANT_B = "11111111-1111-1111-1111-111111111111"

_APP_TENANT = text("SELECT current_setting('app.tenant_id', true)")


class _TenantRecordingRoomStore(RoomStore):
    """A real `RoomStore` that records the tenant Postgres saw for each call.

    The setting is read on the session the service passed in, as its first
    statement, so it reports what `after_begin` stamped on that transaction.
    An unset `app.tenant_id` reads back as NULL on a fresh connection and as
    the empty string on a pooled one whose previous transaction released an
    `is_local` setting (see `db/rls_ddl.py`); both mean "nothing bound", so
    both are normalised to `None`.
    """

    def __init__(self) -> None:
        self.seen: list[tuple[str, str | None]] = []

    async def _note(self, method: str, session: AsyncSession) -> None:
        value = (await session.execute(_APP_TENANT)).scalar()
        self.seen.append((method, value or None))

    def tenants_for(self, method: str) -> list[str | None]:
        return [tenant for name, tenant in self.seen if name == method]

    async def get_all(
        self, session: AsyncSession, *, include_archived: bool = False
    ) -> list[Room]:
        await self._note("get_all", session)
        return await super().get_all(session, include_archived=include_archived)

    async def get(self, session: AsyncSession, room_id: str) -> Room | None:
        await self._note("get", session)
        return await super().get(session, room_id)

    async def get_client_ids(self, session: AsyncSession, room_id: str) -> list[str]:
        await self._note("get_client_ids", session)
        return await super().get_client_ids(session, room_id)

    async def add_client(
        self, session: AsyncSession, client_id: str, room_id: str
    ) -> None:
        await self._note("add_client", session)
        await super().add_client(session, client_id, room_id)

    async def add_agents(
        self,
        session: AsyncSession,
        room_id: str,
        agent_ids: list[str],
        *,
        join_event_listeners: set[str] | None = None,
    ) -> None:
        await self._note("add_agents", session)
        await super().add_agents(
            session, room_id, agent_ids, join_event_listeners=join_event_listeners
        )

    async def set_archived(
        self, session: AsyncSession, room_id: str, archived: bool
    ) -> None:
        await self._note("set_archived", session)
        await super().set_archived(session, room_id, archived)


class _FakeMatrix:
    """Provisioning, which room_service calls with no session open."""

    def __init__(self, *, fail_for: set[str] | None = None) -> None:
        self.invited: list[tuple[str, str]] = []
        self._fail_for = fail_for or set()

    async def invite_to_room(self, matrix_room_id: str, matrix_user_id: str) -> None:
        if matrix_room_id in self._fail_for:
            raise RuntimeError(f"platform refused the invite to {matrix_room_id}")
        self.invited.append((matrix_room_id, matrix_user_id))


class _RunningClient:
    def __init__(self, client_id: str, matrix_user_id: str) -> None:
        self.client_id = client_id
        self.matrix_user_id = matrix_user_id


class _AgentRegistry:
    """Only the agent-client half of `ClientLifecycleService`.

    The *system*-client half is the real service (`_registry` below), because
    that lookup is where the cross-tenant bug lived and a stand-in would have
    reimplemented the fix rather than exercised it. Resolving an agent to its
    running client is not tenant-sensitive — an agent id is unique across the
    deployment — and building real `AgentClient`s to say so would add a
    transport and a sync loop to a test about bindings.
    """

    def __init__(self, agents: dict[str, _RunningClient]) -> None:
        self._agents = agents

    def get_by_type(self, client_type: str, tenant_id: str) -> list[_RunningClient]:
        return []

    def get_by_agent_id(self, agent_id: str) -> _RunningClient | None:
        return self._agents.get(agent_id)

    def get(self, client_id: str) -> _RunningClient | None:
        return None


class _StubClient:
    """A client that stays running until stopped, and touches nothing else.

    `_start_task` removes a client from the registry the moment `start`
    returns, so a stub that finished immediately would empty the registry
    these tests are about.
    """

    def __init__(self, record: Client) -> None:
        self.client_id = record.id
        self.matrix_user_id = record.matrix_user_id
        self.display_name = record.display_name
        self._stopped = asyncio.Event()

    async def start(self) -> None:
        await self._stopped.wait()

    async def stop(self) -> None:
        self._stopped.set()


class _StubFactory:
    def create(self, record: Client) -> Any:
        return _StubClient(record)


def _registry(
    session_factory: async_sessionmaker[AsyncSession],
    running: list[tuple[str, str, str]],
) -> ClientLifecycleService:
    """The real registry, holding `(tenant_id, client_id, matrix_user_id)`.

    The real one on purpose: `reconcile_room_clients` asks it which system
    clients belong to a room's tenant, and getting that answer from the whole
    deployment instead of from one tenant is the defect these tests exist for.
    """
    service = ClientLifecycleService(
        matrix_admin=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=_StubFactory(),  # type: ignore[arg-type]
        session_factory=session_factory,
        config=SimpleNamespace(matrix_server_name="switch.local"),  # type: ignore[arg-type]
    )
    for tenant_id, client_id, matrix_user_id in running:
        service.start_client(
            Client(
                id=client_id,
                tenant_id=tenant_id,
                matrix_user_id=matrix_user_id,
                display_name="admin",
                type="admin",
            )
        )
    return service


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    store: _TenantRecordingRoomStore,
    clients: Any,
    matrix: _FakeMatrix,
) -> RoomService:
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = store  # type: ignore[assignment]
    svc._client_lifecycle = clients  # type: ignore[assignment]
    svc._matrix_admin = matrix  # type: ignore[assignment]
    svc._collab_lifecycle = None  # type: ignore[assignment]
    return svc


async def _seed_tenant_b(session: AsyncSession) -> None:
    session.add(Tenant(id=TENANT_B, slug="tenant-b", name="Tenant B"))
    await session.flush()


async def _seed_room(
    session: AsyncSession, *, tenant_id: str, room_id: str, matrix_room_id: str
) -> None:
    """Insert a room directly, naming its tenant.

    Core-level so no tenant needs binding to build the fixture: which tenants
    a test's fixtures live in is the test's own decision, and going through
    the ORM default here would make it the ambient context's.
    """
    await session.execute(
        insert(Room.__table__).values(
            id=room_id,
            tenant_id=tenant_id,
            name=room_id,
            description="d",
            matrix_room_id=matrix_room_id,
        )
    )


async def _seed_client(
    session: AsyncSession,
    *,
    tenant_id: str,
    client_id: str,
    matrix_user_id: str,
    client_type: str = "admin",
) -> None:
    await session.execute(
        insert(Client.__table__).values(
            id=client_id,
            tenant_id=tenant_id,
            matrix_user_id=matrix_user_id,
            display_name=client_type,
            type=client_type,
        )
    )


async def _seed_agent(
    session: AsyncSession, *, tenant_id: str, agent_id: str, client_id: str
) -> None:
    """An agent and the user/key/client rows its foreign keys need."""
    user_id = str(uuid.uuid4())
    session.add(
        User(id=user_id, name=agent_id, email=f"{agent_id}@x.test", role="user")
    )
    await session.flush()
    key_id = str(uuid.uuid4())
    await session.execute(
        insert(ApiKey.__table__).values(
            id=key_id,
            tenant_id=tenant_id,
            user_id=user_id,
            key_hash=f"hash-{agent_id}",
            encrypted_key="enc",
            label=agent_id,
            type="agent",
        )
    )
    await _seed_client(
        session,
        tenant_id=tenant_id,
        client_id=client_id,
        matrix_user_id=f"@{agent_id}:switch.local",
        client_type="agent",
    )
    await session.execute(
        insert(Agent.__table__).values(
            id=agent_id,
            tenant_id=tenant_id,
            name=agent_id,
            description="d",
            agent_type="external",
            connector_type="test",
            integration_profile={},
            client_id=client_id,
            api_key_id=key_id,
            owner_id=user_id,
        )
    )


async def _client_room_rows(
    session_factory: async_sessionmaker[AsyncSession],
) -> set[tuple[str, str, str]]:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(ClientRoom.tenant_id, ClientRoom.client_id, ClientRoom.room_id)
            )
        ).all()
    return {(t, c, r) for t, c, r in rows}


class TestReconcileRoomClients:
    """The one room_service entry point genuinely reached with nothing bound.

    `main.run()` calls it inline at startup, before uvicorn is listening, so
    everything it does has to name its own tenant and anything it raises is a
    deployment that does not start.
    """

    async def test_each_room_gets_its_own_tenants_admin_client(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Two tenants, an admin client each, a room each.

        Before this, the admin clients were resolved once for the whole
        fan-out from a registry holding every tenant's, so tenant B's room was
        offered tenant zero's admin client. `client_rooms` carries a composite
        foreign key on `(tenant_id, client_id)`, so that is not a wrong row —
        it is a `ForeignKeyViolationError` out of startup.
        """
        async with session_factory() as session:
            await _seed_tenant_b(session)
            await _seed_room(
                session,
                tenant_id=TENANT_ZERO_ID,
                room_id="room-zero",
                matrix_room_id="!zero:switch.local",
            )
            await _seed_room(
                session,
                tenant_id=TENANT_B,
                room_id="room-b",
                matrix_room_id="!b:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_ZERO_ID,
                client_id="admin-zero",
                matrix_user_id="@switch-admin:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_B,
                client_id="admin-b",
                matrix_user_id="@switch-admin:switch.local",
            )
            await session.commit()

        store = _TenantRecordingRoomStore()
        registry = _registry(
            session_factory,
            [
                (TENANT_ZERO_ID, "admin-zero", "@switch-admin:switch.local"),
                (TENANT_B, "admin-b", "@switch-admin:switch.local"),
            ],
        )
        svc = _service(
            session_factory,
            store=store,
            clients=registry,
            matrix=_FakeMatrix(),
        )

        try:
            await svc.reconcile_room_clients()
        finally:
            await registry.stop_all()

        assert await _client_room_rows(session_factory) == {
            (TENANT_ZERO_ID, "admin-zero", "room-zero"),
            (TENANT_B, "admin-b", "room-b"),
        }
        # Each room's work ran under that room's tenant, not under whichever
        # room happened to come first.
        assert sorted(store.tenants_for("add_client")) == sorted(
            [TENANT_ZERO_ID, TENANT_B]
        )
        assert sorted(store.tenants_for("get_client_ids")) == sorted(
            [TENANT_ZERO_ID, TENANT_B]
        )

    async def test_the_room_enumeration_refuses_the_callers_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """ "Which rooms exist" must span tenants whether or not one is bound.

        That is `unscoped_session`'s whole contract (`db/session_scope.py`): a
        helper that named the intent while inheriting the ambient tenant would
        have the hook stamp it on the transaction and the cross-tenant read
        would silently be a single-tenant one — here, a boot that reconciles
        tenant zero's rooms and quietly skips everyone else's.
        """
        async with session_factory() as session:
            await _seed_tenant_b(session)
            await _seed_room(
                session,
                tenant_id=TENANT_B,
                room_id="room-b",
                matrix_room_id="!b:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_B,
                client_id="admin-b",
                matrix_user_id="@switch-admin:switch.local",
            )
            await session.commit()

        store = _TenantRecordingRoomStore()
        registry = _registry(
            session_factory, [(TENANT_B, "admin-b", "@switch-admin:switch.local")]
        )
        svc = _service(
            session_factory,
            store=store,
            clients=registry,
            matrix=_FakeMatrix(),
        )

        try:
            with tenant_scope(TENANT_ZERO_ID):
                await svc.reconcile_room_clients()
                # And it hands the caller's context back untouched.
                assert current_tenant_id() == TENANT_ZERO_ID
        finally:
            await registry.stop_all()

        assert store.tenants_for("get_all") == [None], (
            "the room enumeration inherited the caller's tenant; under the "
            "policies it would have returned none of tenant B's rooms"
        )
        assert await _client_room_rows(session_factory) == {
            (TENANT_B, "admin-b", "room-b")
        }

    async def test_one_rooms_failure_does_not_take_the_others_down(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """This runs before the server is listening. An exception escaping it
        is not a skipped room, it is a deployment that does not start — for
        every tenant, because of one room belonging to one of them."""
        async with session_factory() as session:
            await _seed_tenant_b(session)
            await _seed_room(
                session,
                tenant_id=TENANT_ZERO_ID,
                room_id="room-broken",
                matrix_room_id="!broken:switch.local",
            )
            await _seed_room(
                session,
                tenant_id=TENANT_B,
                room_id="room-b",
                matrix_room_id="!b:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_ZERO_ID,
                client_id="admin-zero",
                matrix_user_id="@switch-admin:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_B,
                client_id="admin-b",
                matrix_user_id="@switch-admin:switch.local",
            )
            await session.commit()

        registry = _registry(
            session_factory,
            [
                (TENANT_ZERO_ID, "admin-zero", "@switch-admin:switch.local"),
                (TENANT_B, "admin-b", "@switch-admin:switch.local"),
            ],
        )
        svc = _service(
            session_factory,
            store=_TenantRecordingRoomStore(),
            clients=registry,
            matrix=_FakeMatrix(fail_for={"!broken:switch.local"}),
        )

        try:
            await svc.reconcile_room_clients()
        finally:
            await registry.stop_all()

        assert await _client_room_rows(session_factory) == {
            (TENANT_B, "admin-b", "room-b")
        }

    async def test_the_failure_is_reported_not_swallowed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Contained, but not quiet: a room left unreconciled is an operator's
        problem, so it is logged at `error` naming the room."""
        async with session_factory() as session:
            await _seed_room(
                session,
                tenant_id=TENANT_ZERO_ID,
                room_id="room-broken",
                matrix_room_id="!broken:switch.local",
            )
            await _seed_client(
                session,
                tenant_id=TENANT_ZERO_ID,
                client_id="admin-zero",
                matrix_user_id="@switch-admin:switch.local",
            )
            await session.commit()

        registry = _registry(
            session_factory,
            [(TENANT_ZERO_ID, "admin-zero", "@switch-admin:switch.local")],
        )
        svc = _service(
            session_factory,
            store=_TenantRecordingRoomStore(),
            clients=registry,
            matrix=_FakeMatrix(fail_for={"!broken:switch.local"}),
        )

        try:
            with caplog.at_level("ERROR", logger="switch_core.room_service"):
                await svc.reconcile_room_clients()
        finally:
            await registry.stop_all()

        errors = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
        assert any("room-broken" in message for message in errors), errors


class TestBindingsOnTheRoomsOwnTenant:
    """The rest of the file's shape: read the room, then act as *its* tenant.

    Exercised with nothing bound, which is what makes the binding observable
    at all — with the caller's tenant already equal to the room's, a helper
    that bound nothing and one that bound the right thing are the same run.
    """

    async def test_adding_an_agent_files_the_membership_under_the_rooms_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`room_agents.tenant_id` has no server default — its Python-side
        default is `require_tenant_id`, which raises rather than guessing. So
        this write does not merely land in the wrong tenant without the
        binding; it does not land at all."""
        async with session_factory() as session:
            await _seed_tenant_b(session)
            await _seed_room(
                session,
                tenant_id=TENANT_B,
                room_id="room-b",
                matrix_room_id="!b:switch.local",
            )
            with tenant_scope(TENANT_B):
                await _seed_agent(
                    session,
                    tenant_id=TENANT_B,
                    agent_id="agent-b",
                    client_id="client-b",
                )
            await session.commit()

        store = _TenantRecordingRoomStore()
        svc = _service(
            session_factory,
            store=store,
            clients=_AgentRegistry(
                {"agent-b": _RunningClient("client-b", "@agent-b:switch.local")}
            ),
            matrix=_FakeMatrix(),
        )

        assert current_tenant_id() is None
        await svc.add_agents_to_room("room-b", agent_ids=["agent-b"])

        assert store.tenants_for("add_agents") == [TENANT_B]
        assert store.tenants_for("add_client") == [TENANT_B]
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(room_agents.c.tenant_id, room_agents.c.agent_id)
                )
            ).all()
        assert [(t, a) for t, a in rows] == [(TENANT_B, "agent-b")]
        assert await _client_room_rows(session_factory) == {
            (TENANT_B, "client-b", "room-b")
        }

    async def test_an_update_runs_under_the_rooms_tenant_and_lets_go_after(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`tenant_session` binds for the block and unbinds in a `finally`.

        The unbinding half matters as much as the binding: room_service is
        reached from long-lived callers, and a tenant that outlived its block
        would decide what the next unit of work reads.
        """
        async with session_factory() as session:
            await _seed_tenant_b(session)
            await _seed_room(
                session,
                tenant_id=TENANT_B,
                room_id="room-b",
                matrix_room_id="!b:switch.local",
            )
            await session.commit()

        store = _TenantRecordingRoomStore()
        svc = _service(
            session_factory,
            store=store,
            clients=_AgentRegistry({}),
            matrix=_FakeMatrix(),
        )

        await svc.set_room_archived("room-b", True)

        assert store.tenants_for("set_archived") == [TENANT_B]
        assert current_tenant_id() is None, (
            "the room's tenant outlived the block that bound it"
        )
        async with session_factory() as session:
            archived_at = (
                await session.execute(
                    select(Room.archived_at).where(Room.id == "room-b")
                )
            ).scalar()
        assert archived_at is not None

    async def test_a_scoped_write_with_nothing_bound_raises_rather_than_guessing(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The floor everything above rests on, stated once.

        `require_tenant_id` used to answer tenant zero when nothing was bound.
        It raises now, which is what turns "this call site forgot to bind"
        from a row quietly filed under a real customer into a failure — and
        what makes the tests above able to tell the difference at all.
        """
        async with session_factory() as session:
            await _seed_room(
                session,
                tenant_id=TENANT_ZERO_ID,
                room_id="room-zero",
                matrix_room_id="!zero:switch.local",
            )
            await session.commit()

        async with session_factory() as session:
            # SQLAlchemy wraps a column default that raises, so the cause is
            # where the rule is stated rather than the type pytest sees.
            with pytest.raises(StatementError) as raised:
                await RoomStore().add_agents(session, "room-zero", ["agent-x"])
        assert isinstance(raised.value.orig, TenantNotBoundError)


class TestTheStandInMatchesTheRealSignature:
    """`_AgentRegistry` covers the half of `ClientLifecycleService` these
    tests do not use for real.

    A stand-in that drifts from the thing it stands for is how a suite keeps
    passing against an interface nobody implements any more, so the shapes are
    compared rather than assumed.
    """

    def test_get_by_type_takes_a_tenant(self) -> None:
        real = inspect.signature(ClientLifecycleService.get_by_type)
        stand_in = inspect.signature(_AgentRegistry.get_by_type)
        assert list(real.parameters) == list(stand_in.parameters)
