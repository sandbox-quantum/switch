"""A re-check starts a bridge only from a version of its row not tried here.

Every process re-reads the bridges' rows when a `bridge.changed` signal says
one changed and on a periodic re-check (`bridge_signals.py`). What it starts or
restarts is decided by whether it has started the bridge from that version of
the row already. So a bridge that crashed or failed to start stays down until
it is edited or restarted, as it does with one process, rather than being
tried again every re-check; and an edit made elsewhere is applied here.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration import lifecycle_service as lifecycle_module
from switch_core.db.models import CollaborationBridge
from tests.switch_core.bridges.collaboration.test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _service,
    _StubAdapter,
    _StubConfig,
)


async def _bridge(session_factory: async_sessionmaker[AsyncSession]) -> str:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant)
        bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
        await session.commit()
    return bridge_id


async def _edit(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> None:
    async with session_factory() as session:
        await session.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge_id)
            .values(display_name="renamed")
        )
        await session.commit()


async def test_a_running_bridge_is_left_alone_until_its_row_changes(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The stand-in task below runs until cancelled rather than until its
    # consumer stops, so a stop need not give it the grace a real one gets.
    monkeypatch.setattr(lifecycle_module, "STOP_GRACE_SECONDS", 0.01)
    bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("slack", _StubAdapter, _StubConfig)
    starts: list[str] = []

    async def run(bridge_id: str, *_: object) -> None:
        # Running until stopped, as a bridge's task does.
        starts.append(bridge_id)
        await asyncio.Event().wait()

    service._run_bridge = run  # type: ignore[method-assign]
    try:
        await service.reconcile_all()
        await asyncio.sleep(0)
        assert starts == [bridge_id]

        await service.reconcile_all()
        await asyncio.sleep(0)
        assert starts == [bridge_id]

        await _edit(session_factory, bridge_id)
        await service.reconcile_bridge(bridge_id)
        await asyncio.sleep(0)
        assert starts == [bridge_id, bridge_id]
    finally:
        await service.stop_all()


async def test_a_bridge_that_failed_to_start_is_tried_again_only_once_edited(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """No adapter is registered for the bridge's platform, so every start
    fails before anything runs."""
    bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    attempts: list[str] = []
    start = service._start_bridge

    async def counted(bridge_id: str) -> None:
        attempts.append(bridge_id)
        await start(bridge_id)

    service._start_bridge = counted  # type: ignore[method-assign]
    try:
        await service.reconcile_all()
        await service.reconcile_all()
        assert attempts == [bridge_id]

        await _edit(session_factory, bridge_id)
        await service.reconcile_all()
        assert attempts == [bridge_id, bridge_id]
    finally:
        await service.stop_all()
