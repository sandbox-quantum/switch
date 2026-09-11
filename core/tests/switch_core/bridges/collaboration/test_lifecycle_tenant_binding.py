"""A bridge runs under its own tenant, whoever started it (CHOO-2623).

The rule these pin: **nothing is ambient.** A bridge is started from two
places — boot, with no tenant bound, and an HTTP request that edited its
config, with the *requesting operator's* tenant bound — and an `asyncio.Task`
snapshots the contextvars of whoever created it. So the tenant a bridge acts
under must never be the one that happened to be bound when its task was made.

`start` reads the bridge's own row unscoped to learn its tenant, hands that
value to the task, and the task unbinds before doing anything. Each unit of
work then binds the tenant it derived from a row: the bridge's for the
bridge's own startup, the room's for anything room-scoped. `start_all` binds
nothing at all, because there is nothing left for it to bind.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import CollaborationAdapter
from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.bridges.collaboration.models import BridgeConnectionConfig
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    CollaborationBridge,
    Room,
    Tenant,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import current_tenant_id, tenant_scope
from tests.conftest import RLSHarness


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    return CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
        session_request_post_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
    )


class _StubAdapter(CollaborationAdapter):
    """Concrete only so `start` can build one; no platform call is made."""

    def __init__(self, *, config: Any) -> None:
        self._config = config

    async def start(self, *a: Any, **k: Any) -> Any: ...
    async def stop(self, *a: Any, **k: Any) -> Any: ...
    async def send_message(self, *a: Any, **k: Any) -> Any: ...
    async def send_typing(self, *a: Any, **k: Any) -> Any: ...
    async def update_message(self, *a: Any, **k: Any) -> Any: ...
    async def delete_message(self, *a: Any, **k: Any) -> Any: ...
    async def create_channel(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_type(self, *a: Any, **k: Any) -> Any: ...
    async def get_channel_agent_names(self, *a: Any, **k: Any) -> Any: ...
    async def add_agents_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def add_users_to_channel(self, *a: Any, **k: Any) -> Any: ...
    async def create_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    async def remove_agent_identity(self, *a: Any, **k: Any) -> Any: ...
    def translate_inbound(self, *a: Any, **k: Any) -> Any: ...
    def translate_outbound(self, *a: Any, **k: Any) -> Any: ...


class _StubConfig(BridgeConnectionConfig):
    pass


async def _make_tenant(session: AsyncSession, tenant_id: str) -> None:
    session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
    await session.flush()


async def _make_bridge(session: AsyncSession, *, tenant_id: str) -> tuple[str, str]:
    """A bridge row and its client, in `tenant_id`. Returns (bridge, client)."""
    client = Client(
        tenant_id=tenant_id,
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        tenant_id=tenant_id,
        type="mattermost",
        display_name="MM",
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id, client.id


@pytest.mark.no_ambient_tenant
async def test_start_all_binds_nothing_around_starting_a_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The enumeration is unscoped and stays that way. Binding a tenant here
    would only choose what each bridge's task snapshots, which is exactly the
    dependency the design removed — `start` derives the tenant from the row."""
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        bridge_a, _ = await _make_bridge(session, tenant_id=tenant_a)
        bridge_b, _ = await _make_bridge(session, tenant_id=tenant_b)
        await session.commit()

    service = _service(session_factory)
    seen: dict[str, str | None] = {}

    async def _fake_start(bridge_id: str) -> None:
        seen[bridge_id] = current_tenant_id()

    service.start = _fake_start  # type: ignore[method-assign]

    assert current_tenant_id() is None
    await service.start_all()
    assert current_tenant_id() is None

    assert seen == {bridge_a: None, bridge_b: None}


@pytest.mark.no_ambient_tenant
async def test_a_failing_bridge_leaves_nothing_bound_for_the_next_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """start_all logs and continues past a bridge that fails to start; that
    must not leave the loop in a different state than it began in."""
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        bridge_a, _ = await _make_bridge(session, tenant_id=tenant_a)
        bridge_b, _ = await _make_bridge(session, tenant_id=tenant_b)
        await session.commit()

    service = _service(session_factory)
    seen: dict[str, str | None] = {}

    async def _fake_start(bridge_id: str) -> None:
        seen[bridge_id] = current_tenant_id()
        if bridge_id == bridge_a:
            raise RuntimeError("boom")

    service.start = _fake_start  # type: ignore[method-assign]

    await service.start_all()

    assert seen == {bridge_a: None, bridge_b: None}
    assert current_tenant_id() is None


async def test_start_hands_the_task_the_bridges_tenant_not_the_callers(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The restart path (`gateway/collaborations.py` edits a connection and
    calls `restart`) reaches `start` with the requesting operator's tenant
    bound. The tenant the bridge is then run under has to come off the bridge
    row, not out of the request."""
    bridge_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    caller_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, bridge_tenant)
        await _make_tenant(session, caller_tenant)
        bridge_id, _ = await _make_bridge(session, tenant_id=bridge_tenant)
        await session.commit()

    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)
    handed: list[str] = []

    async def _fake_run(bridge_id: str, tenant_id: str, *_: object) -> None:
        handed.append(tenant_id)

    service._run_bridge = _fake_run  # type: ignore[method-assign]

    with tenant_scope(caller_tenant):
        await service.start(bridge_id)
        # `start` spawns the task and returns; let it reach its first line.
        await asyncio.sleep(0)

    await service.stop(bridge_id)

    assert handed == [bridge_tenant]


async def test_the_bridge_task_unbinds_and_then_binds_per_unit_of_work(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The task body itself, created from a foreign tenant's context.

    Three things at once, because they are one rule: the membership rows the
    bridge records land in the bridge's tenant (not the creator's, which the
    composite foreign keys would reject outright); the bridge's own startup
    sees nothing bound, so anything it does has to bind for itself; and the
    client loop that runs until shutdown sees nothing bound either, leaving
    each delivery to bind the room it is for.
    """
    bridge_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    caller_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, bridge_tenant)
        await _make_tenant(session, caller_tenant)
        bridge_id, client_id = await _make_bridge(session, tenant_id=bridge_tenant)
        room = Room(
            tenant_id=bridge_tenant,
            matrix_room_id=f"!room-{uuid.uuid4().hex[:8]}:test",
            name="a bridged room",
            description="",
            bridge_id=bridge_id,
            external_channel_id="C1",
        )
        session.add(room)
        await session.commit()
        room_id = room.id

    service = _service(session_factory)
    seen: dict[str, str | None] = {}

    class _Core:
        async def start(self) -> None:
            seen["core"] = current_tenant_id()

    class _Client:
        client_id = ""

        async def start(self) -> None:
            seen["client"] = current_tenant_id()

    bridge_client = _Client()
    bridge_client.client_id = client_id

    leaked: list[str | None] = []
    with tenant_scope(caller_tenant):
        await service._run_bridge(
            bridge_id,
            bridge_tenant,
            _Core(),  # type: ignore[arg-type]
            bridge_client,  # type: ignore[arg-type]
        )
        leaked.append(current_tenant_id())

    async with session_factory() as session:
        rows = (
            (
                await session.execute(
                    select(ClientRoom.tenant_id).where(ClientRoom.room_id == room_id)
                )
            )
            .scalars()
            .all()
        )

    assert rows == [bridge_tenant], (
        "the bridge recorded its membership under the tenant of whoever "
        "started it rather than its own"
    )
    assert seen == {"core": None, "client": None}
    assert leaked == [caller_tenant], (
        "the task's unbinding escaped it and cleared its creator's context"
    )


async def test_a_host_resource_conflict_is_looked_for_across_every_tenant(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two tenants cannot share a Teams listen port or a Slack workspace: the
    resource belongs to the host and the platform, not to a tenant. So the
    check that refuses the second claimant has to see the first even when it
    belongs to someone else — narrowing it to the caller's tenant would make
    it miss precisely the case it exists for.

    Under row-level security an unscoped read is not available — it is
    exactly the state `require_tenant_id()` raises on — so seeing every
    tenant's bridges takes `all_tenant_ids()` (the exemption in
    `db/tenant_lookup.py`) plus one ordinary *scoped* `get_all` per tenant.
    The conflict itself is asserted, and so is what each of those reads was
    bound to: one call per tenant that exists — tenant zero seeded by the
    test schema, plus the incumbent and the newcomer created here — each
    bound to that tenant rather than to the caller's. The incumbent and the
    newcomer are both inserted inside one transaction, so `now()` — and so
    `all_tenant_ids`' `ORDER BY created_at` — ties between them; which of the
    two is visited first is not the property under test, only that every
    tenant is visited exactly once, each under its own binding, and never
    under the caller's tenant alone or left unbound.

    `test_a_tenant_scoped_read_of_the_same_data_would_have_missed_the_conflict`
    below runs the identical two-bridge fixture through the row-level-security
    policies (`rls_harness`, a role they actually apply to) and shows a read
    scoped to only the newcomer's tenant does not see the incumbent's row —
    the failure this loop over every tenant exists to avoid.
    """
    incumbent_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    newcomer_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, incumbent_tenant)
        await _make_tenant(session, newcomer_tenant)
        client = Client(
            tenant_id=incumbent_tenant,
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=incumbent_tenant,
                type="teams",
                display_name="Their Teams",
                client_id=client.id,
                status="active",
                connection_config={"listen_port": 3979},
            )
        )
        await session.commit()

    class _PortHoldingAdapter(_StubAdapter):
        @staticmethod
        def exclusive_resource(config: dict[str, Any]) -> str | None:
            port = config.get("listen_port")
            return f"port:{port}" if port else None

    seen: list[str | None] = []
    original = CollaborationBridgeStore.get_all

    async def _spy(self, session):  # type: ignore[no-untyped-def]
        seen.append(current_tenant_id())
        return await original(self, session)

    monkeypatch.setattr(CollaborationBridgeStore, "get_all", _spy)

    service = _service(session_factory)
    service.register_adapter("teams", _PortHoldingAdapter, _StubConfig)

    with tenant_scope(newcomer_tenant):
        with pytest.raises(ValueError, match="port:3979 is already claimed"):
            await service._reject_resource_conflict("teams", {"listen_port": 3979})

    assert sorted(seen) == sorted(
        [TENANT_ZERO_ID, incumbent_tenant, newcomer_tenant]
    ), (
        "the conflict check must read the stored bridges tenant by tenant, "
        "each scoped to the tenant being read rather than to the caller's — "
        "a read scoped only to the newcomer's tenant would not have seen "
        "the incumbent and would have let both claim the port"
    )


async def test_a_tenant_scoped_read_of_the_same_data_would_have_missed_the_conflict(
    rls_harness: RLSHarness,
) -> None:
    """The row-visibility half of the test above, made real: the same
    incumbent bridge, read through `CollaborationBridgeStore.get_all` — the
    exact method `_reject_resource_conflict` calls — but scoped to the
    newcomer's tenant instead of left unscoped. It comes back empty, which is
    what would have let a second Teams listener claim the same port undetected
    had the application code above been scoped instead of deliberately
    unscoped.
    """
    incumbent_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    newcomer_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with rls_harness.owner() as session:
        await _make_tenant(session, incumbent_tenant)
        await _make_tenant(session, newcomer_tenant)
        client = Client(
            tenant_id=incumbent_tenant,
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=incumbent_tenant,
                type="teams",
                display_name="Their Teams",
                client_id=client.id,
                status="active",
                connection_config={"listen_port": 3979},
            )
        )
        await session.commit()

    async with tenant_session(rls_harness.restricted, newcomer_tenant) as session:
        bridges = await CollaborationBridgeStore().get_all(session)

    assert bridges == [], (
        "a read scoped to the newcomer's tenant still saw the incumbent's "
        "bridge — row-level security should have hidden it, which is what "
        "the application code avoids by calling get_all unscoped"
    )


class _PortHoldingAdapter(_StubAdapter):
    @staticmethod
    def exclusive_resource(config: dict[str, Any]) -> str | None:
        port = config.get("listen_port")
        return f"port:{port}" if port else None


async def test_a_same_tenant_conflict_names_the_incumbent_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The exclusivity check still has to be *actionable* for the ordinary
    case: an operator who registers a second Teams bridge on a port their own
    first one already holds needs to be told which of their own bridges to
    delete or move. They can already see its name on their own bridge list, so
    naming it here discloses nothing they could not already read."""
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant)
        client = Client(
            tenant_id=tenant,
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=tenant,
                type="teams",
                display_name="Our Existing Teams",
                client_id=client.id,
                status="active",
                connection_config={"listen_port": 3979},
            )
        )
        await session.commit()

    service = _service(session_factory)
    service.register_adapter("teams", _PortHoldingAdapter, _StubConfig)

    with tenant_scope(tenant):
        with pytest.raises(ValueError) as excinfo:
            await service._reject_resource_conflict("teams", {"listen_port": 3979})

    assert "Our Existing Teams" in str(excinfo.value)


async def test_a_cross_tenant_conflict_does_not_name_the_incumbent_or_its_tenant(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The other half of finding CHOO-2623's cross-tenant disclosure: refusing
    the conflict is still required (two tenants cannot share a Teams port or a
    Slack workspace), but the message reaching an unrelated tenant must not
    leak who holds the resource or that they exist on this instance at all.
    `wanted` (`port:3979`) is not itself a disclosure — it is an echo of the
    connection_config the caller just submitted — but the incumbent's display
    name and tenant id must appear nowhere in the raised message.
    """
    incumbent_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    newcomer_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, incumbent_tenant)
        await _make_tenant(session, newcomer_tenant)
        client = Client(
            tenant_id=incumbent_tenant,
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="Their Secret Teams",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=incumbent_tenant,
                type="teams",
                display_name="Their Secret Teams",
                client_id=client.id,
                status="active",
                connection_config={"listen_port": 3979},
            )
        )
        await session.commit()

    service = _service(session_factory)
    service.register_adapter("teams", _PortHoldingAdapter, _StubConfig)

    with tenant_scope(newcomer_tenant):
        with pytest.raises(ValueError) as excinfo:
            await service._reject_resource_conflict("teams", {"listen_port": 3979})

    message = str(excinfo.value)
    assert "Their Secret Teams" not in message
    assert incumbent_tenant not in message
    assert "already claimed" in message


@pytest.mark.no_ambient_tenant
async def test_a_conflict_with_nothing_bound_fails_closed_to_the_non_disclosing_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A call reached with no tenant bound at all (no request behind it, if
    one ever exists) must not be treated as though it were the incumbent's own
    tenant purely because `None == None` would otherwise compare equal to an
    unset `tenant_id` — there is no such column, but the principle is the
    same one `exclude_bridge_id`'s own None-guard states a few lines above:
    an absent value must not accidentally satisfy a check meant to require a
    real match. Nothing bound must get the same refusal an unrelated tenant
    gets, not the same one the incumbent's own tenant gets.
    """
    incumbent_tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, incumbent_tenant)
        client = Client(
            tenant_id=incumbent_tenant,
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="Their Secret Teams",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        session.add(
            CollaborationBridge(
                tenant_id=incumbent_tenant,
                type="teams",
                display_name="Their Secret Teams",
                client_id=client.id,
                status="active",
                connection_config={"listen_port": 3979},
            )
        )
        await session.commit()

    service = _service(session_factory)
    service.register_adapter("teams", _PortHoldingAdapter, _StubConfig)

    assert current_tenant_id() is None
    with pytest.raises(ValueError) as excinfo:
        await service._reject_resource_conflict("teams", {"listen_port": 3979})

    message = str(excinfo.value)
    assert "Their Secret Teams" not in message
    assert incumbent_tenant not in message
    assert "already claimed" in message
