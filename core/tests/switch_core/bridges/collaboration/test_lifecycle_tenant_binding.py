"""`CollaborationBridgeLifecycleService.start_all` (CHOO-2623): starting every
bridge at boot has no request behind it, and it fans out across every
tenant's bridges in one pass — so the read that finds them has to be
unscoped, and each bridge's own tenant is what gets bound, not the whole
sweep. `start` spawns the bridge's long-lived task while that binding is
still active, so the task keeps it for its own life (an asyncio task
snapshots the context it was created under).

This does not exercise a real bridge — `start` here is stubbed to record what
tenant was bound when it was called, which is the only thing `start_all`
itself is responsible for getting right.
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import current_tenant_id


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    return CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=MagicMock(),
        bridge_message_map_store=MagicMock(),
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


async def _make_tenant(session: AsyncSession, tenant_id: str) -> None:
    session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
    await session.flush()


async def _make_bridge(session: AsyncSession, *, tenant_id: str) -> str:
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
    return bridge.id


async def test_start_all_binds_each_bridge_s_own_tenant_and_does_not_leak(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        bridge_a = await _make_bridge(session, tenant_id=tenant_a)
        bridge_b = await _make_bridge(session, tenant_id=tenant_b)
        await session.commit()

    service = _service(session_factory)
    seen: dict[str, str | None] = {}

    async def _fake_start(bridge_id: str) -> None:
        seen[bridge_id] = current_tenant_id()

    service.start = _fake_start  # type: ignore[method-assign]

    # Nothing bound going in, and nothing bound coming out: start_all is
    # itself reached with no request behind it.
    assert current_tenant_id() is None
    await service.start_all()
    assert current_tenant_id() is None

    assert seen == {bridge_a: tenant_a, bridge_b: tenant_b}


async def test_a_failing_bridge_still_releases_its_tenant_for_the_next_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """start_all logs and continues past a bridge that fails to start
    (bridge_core.py's own behaviour); the tenant binding must not survive
    the exception either, or the next bridge in the loop inherits it."""
    tenant_a = f"tenant-{uuid.uuid4().hex[:8]}"
    tenant_b = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant_a)
        await _make_tenant(session, tenant_b)
        bridge_a = await _make_bridge(session, tenant_id=tenant_a)
        bridge_b = await _make_bridge(session, tenant_id=tenant_b)
        await session.commit()

    service = _service(session_factory)
    seen: dict[str, str | None] = {}

    async def _fake_start(bridge_id: str) -> None:
        seen[bridge_id] = current_tenant_id()
        if bridge_id == bridge_a:
            raise RuntimeError("boom")

    service.start = _fake_start  # type: ignore[method-assign]

    await service.start_all()

    assert seen == {bridge_a: tenant_a, bridge_b: tenant_b}
    assert current_tenant_id() is None
