"""A tenant cannot reach another tenant's collaboration bridge by naming its id.

The running bridges live in one process-wide registry, so a `bridge_id` taken
from a caller has to be checked against the bound tenant's own bridges before
anything happens on the platform behind it. Otherwise a channel (or a DM, or a
directory lookup) runs on the other tenant's Slack or Mattermost, and only the
database insert that follows fails on the composite foreign key — after the
side effect.

Real Postgres, with the service connected as a role row-level security
applies to (`rls_harness.restricted`), because that is what makes the other
tenant's bridge row invisible in production. The running bridge is faked, and
records every platform call so a test can assert none was made.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import RoomCreateConfig, RoomService
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


class _FakeProvisioning:
    def __init__(self) -> None:
        self._n = 0

    async def create_room(self, name: str, topic: str) -> str:
        self._n += 1
        return f"!room-{self._n}:switch.local"

    async def invite_to_room(self, room_id: str, user_id: str) -> None:
        return None

    async def kick_user(self, room_id: str, user_id: str) -> None:
        return None


class _RecordingAdapter:
    def __init__(self, calls: list[str]) -> None:
        self._calls = calls

    async def create_channel(
        self, name: str, topic: str, *, channel_type: str = "channel_public"
    ) -> str:
        self._calls.append("create_channel")
        return "chan-foreign"

    async def create_dm_channel(self, **kwargs: Any) -> str:
        self._calls.append("create_dm_channel")
        return "dm-foreign"

    async def get_channel_type(self, external_channel_id: str) -> str:
        self._calls.append("get_channel_type")
        return "channel_public"

    async def add_agents_to_channel(
        self, channel_id: str, agent_names: list[str]
    ) -> None:
        self._calls.append("add_agents_to_channel")

    async def ensure_channel_subscriptions(
        self, channels: list[tuple[str, str]]
    ) -> None:
        self._calls.append("ensure_channel_subscriptions")


class _RecordingCollaborationCore:
    def __init__(self, tenant_id: str) -> None:
        self.calls: list[str] = []
        self.tenant_id = tenant_id
        self._workspace_consumer_transport_user_id = "@bot:switch.local"
        self.adapter = _RecordingAdapter(self.calls)

    async def resolve_external_user_id_map(self, names: list[str]) -> dict[str, str]:
        self.calls.append("resolve_external_user_id_map")
        return {name: f"ext-{name}" for name in names}

    def begin_provisioning(self, external_channel_id: str) -> None:
        return None

    def end_provisioning(self, external_channel_id: str) -> None:
        return None

    def add_room_mapping(self, *args: Any) -> None:
        self.calls.append("add_room_mapping")

    def remove_room_mapping(self, *args: Any) -> None:
        return None


class _FakeLifecycle:
    def __init__(self, bridges: dict[str, _RecordingCollaborationCore]) -> None:
        self._bridges = bridges

    def get(self, bridge_id: str) -> Any:
        return self._bridges.get(bridge_id)


class _NoRunningClients:
    def get_by_agent_id(self, agent_id: str) -> Any:
        return None

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return []

    def get(self, client_id: str) -> Any:
        return None


async def _make_tenant(session_factory: async_sessionmaker[AsyncSession]) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return tenant_id


async def _make_bridge(
    session_factory: async_sessionmaker[AsyncSession], *, tenant_id: str
) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.local",
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
            channel_creation_enabled=True,
        )
        session.add(bridge)
        await session.flush()
        await session.commit()
        return bridge.id


def _service(
    session_factory: async_sessionmaker[AsyncSession],
    bridges: dict[str, _RecordingCollaborationCore],
) -> RoomService:
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[assignment]
    svc._room_store = RoomStore()  # type: ignore[assignment]
    svc._agent_store = AgentStore()  # type: ignore[assignment]
    svc._client_lifecycle = _NoRunningClients()  # type: ignore[assignment]
    svc._collab_lifecycle = _FakeLifecycle(bridges)  # type: ignore[assignment]
    svc._collab_bridge_store = CollaborationBridgeStore()  # type: ignore[assignment]
    svc._provisioning = _FakeProvisioning()  # type: ignore[assignment]
    return svc


@pytest.fixture
async def setup(
    rls_harness: RLSHarness,
) -> tuple[RoomService, str, str, _RecordingCollaborationCore]:
    """Tenant A owns a running bridge; returns a service, tenant B, A's bridge
    id, and A's bridge so a test can check nothing ran on it."""
    tenant_a = await _make_tenant(rls_harness.owner)
    tenant_b = await _make_tenant(rls_harness.owner)
    bridge_a = await _make_bridge(rls_harness.owner, tenant_id=tenant_a)
    core_a = _RecordingCollaborationCore(tenant_a)
    svc = _service(rls_harness.restricted, {bridge_a: core_a})
    return svc, tenant_b, bridge_a, core_a


async def test_create_room_refuses_another_tenants_bridge(setup: Any) -> None:
    svc, tenant_b, bridge_a, core_a = setup
    with tenant_scope(tenant_b), pytest.raises(ValueError, match="Bridge not found"):
        await svc.create_room(
            RoomCreateConfig(name="r", description="d", bridge_id=bridge_a)
        )
    assert core_a.calls == []


async def test_create_room_refuses_another_tenants_bridge_for_an_existing_channel(
    setup: Any,
) -> None:
    svc, tenant_b, bridge_a, core_a = setup
    with tenant_scope(tenant_b), pytest.raises(ValueError, match="Bridge not found"):
        await svc.create_room(
            RoomCreateConfig(
                name="r",
                description="d",
                bridge_id=bridge_a,
                external_channel_id="chan-existing",
            )
        )
    assert core_a.calls == []


async def test_link_bridge_refuses_another_tenants_bridge(setup: Any) -> None:
    svc, tenant_b, bridge_a, core_a = setup
    with tenant_scope(tenant_b):
        own = await svc.create_room(
            RoomCreateConfig(name="r", description="d", internal_only=True)
        )
        with pytest.raises(ValueError, match="Bridge not found"):
            await svc.link_bridge_to_room(own.room.id, bridge_a, "channel_public")
    assert core_a.calls == []


async def test_change_bridge_refuses_another_tenants_bridge(setup: Any) -> None:
    svc, tenant_b, bridge_a, core_a = setup
    with tenant_scope(tenant_b):
        own = await svc.create_room(
            RoomCreateConfig(name="r", description="d", internal_only=True)
        )
        with pytest.raises(ValueError, match="Bridge not found"):
            await svc.change_bridge(own.room.id, bridge_id=bridge_a)
    assert core_a.calls == []


async def test_resolve_bridge_users_refuses_another_tenants_bridge(
    setup: Any,
) -> None:
    svc, tenant_b, bridge_a, core_a = setup
    with tenant_scope(tenant_b), pytest.raises(ValueError, match="Bridge not found"):
        await svc.resolve_bridge_users(bridge_a, ["someone"])
    assert core_a.calls == []
