"""`create_room` resolves the instance default bridge — now per tenant
(CHOO-2623).

`CollaborationBridgeStore.get_default` used to select `is_default` with no
tenant filter and finish in `.one_or_none()`. That was correct as long as at
most one bridge anywhere was ever marked default. The partial unique index
backing `is_default` became `unique (tenant_id) where is_default`
(`ix_collaboration_bridges_single_default`), so the moment a second tenant
nominates its own default, the same unfiltered query matches both rows and
raises `MultipleResultsFound` — a 500 out of `create_room`, for *every*
tenant, including the one that already had a working default before the
second ever onboarded.

Exercised through `RoomService.create_room` against real Postgres
(`CollaborationBridgeStore` and `RoomStore` are the production ones) rather
than by calling `get_default` directly, because "does the room a caller asked
for actually get created" is what regressed and what a fix has to restore.
Only `_matrix_admin` and the collaboration bridge's own runtime handle
(`_collab_lifecycle`) are faked — Matrix and a live bridge connection are not
this bug's concern, and each room's `bridge_id` still has to satisfy the real
composite foreign key to `collaboration_bridges (tenant_id, id)`, so a fix
that resolved the *wrong* tenant's default would fail loudly here too.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.tenant_context import tenant_scope

pytestmark = pytest.mark.no_ambient_tenant


class _FakeMatrix:
    """Provisioning, which room_service calls with no session open."""

    def __init__(self) -> None:
        self._n = 0
        self.invited: list[tuple[str, str]] = []

    async def create_room(self, name: str, topic: str) -> str:
        self._n += 1
        return f"!room-{self._n}:switch.local"

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        self.invited.append((room_id, user_id))


class _FakeAdapter:
    async def create_channel(
        self, name: str, topic: str, *, channel_type: str = "channel_public"
    ) -> str:
        return f"chan-{uuid.uuid4().hex[:8]}"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        return None

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        return None


class _FakeBridgeCore:
    """The running half of a bridge — `create_room` never opens a session on
    this, so it does not need to be the real `BridgeCore`."""

    def __init__(self, matrix_user_id: str) -> None:
        self._bridge_client_matrix_user_id = matrix_user_id
        self.adapter = _FakeAdapter()
        self.mappings: list[tuple[str, str, str, str]] = []

    def begin_provisioning(self, external_channel_id: str) -> None:
        return None

    def end_provisioning(self, external_channel_id: str) -> None:
        return None

    def add_room_mapping(
        self,
        room_id: str,
        matrix_room_id: str,
        external_channel_id: str,
        tenant_id: str,
    ) -> None:
        self.mappings.append((room_id, matrix_room_id, external_channel_id, tenant_id))


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, _FakeBridgeCore]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _NoRunningClients:
    """No agents, no already-running system clients — keeps the test to
    exactly the bridge-resolution path the bug is in."""

    def get_by_agent_id(self, agent_id: str) -> Any:
        return None

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []


async def _make_default_bridge(session: AsyncSession, *, tenant_id: str) -> str:
    """A bridge client and a bridge nominated default, filed under `tenant_id`."""
    with tenant_scope(tenant_id):
        client = Client(
            matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.local",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="mattermost",
            display_name="MM",
            client_id=client.id,
            status="active",
            is_default=True,
        )
        session.add(bridge)
        await session.flush()
        return bridge.id


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    bridges: dict[str, _FakeBridgeCore],
    matrix: _FakeMatrix,
) -> RoomService:
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._client_lifecycle = _NoRunningClients()  # type: ignore[assignment]
    svc._collab_lifecycle = _FakeLifecycle(bridges)  # type: ignore[assignment]
    svc._collab_bridge_store = CollaborationBridgeStore()  # type: ignore[assignment]
    svc._matrix_admin = matrix  # type: ignore[assignment]
    return svc


async def test_create_room_succeeds_for_each_tenants_own_default_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"

    async with session_factory() as session:
        session.add_all(
            [
                Tenant(id=tenant_a, slug=tenant_a, name="A"),
                Tenant(id=tenant_b, slug=tenant_b, name="B"),
            ]
        )
        await session.flush()
        bridge_a = await _make_default_bridge(session, tenant_id=tenant_a)
        bridge_b = await _make_default_bridge(session, tenant_id=tenant_b)
        await session.commit()

    matrix = _FakeMatrix()
    svc = _service(
        session_factory,
        bridges={
            bridge_a: _FakeBridgeCore("@bot-a:switch.local"),
            bridge_b: _FakeBridgeCore("@bot-b:switch.local"),
        },
        matrix=matrix,
    )

    # Before the fix this raised MultipleResultsFound out of
    # `CollaborationBridgeStore.get_default` — for tenant A too, even though
    # tenant A's own default bridge was never ambiguous on its own.
    with tenant_scope(tenant_a):
        result_a = await svc.create_room(
            RoomCreateConfig(name="Room A", description="d")
        )
    with tenant_scope(tenant_b):
        result_b = await svc.create_room(
            RoomCreateConfig(name="Room B", description="d")
        )

    assert result_a.room.bridge_id == bridge_a
    assert result_a.room.tenant_id == tenant_a
    assert result_b.room.bridge_id == bridge_b
    assert result_b.room.tenant_id == tenant_b
