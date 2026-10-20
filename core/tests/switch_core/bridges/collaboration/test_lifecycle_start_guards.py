"""A start guard can stop a bridge before any of it runs.

Guards answer what a bridge's own config cannot: whether the workspace it
names is its tenant's. A refusal has to come before the adapter is built, so a
refused bridge never reaches its platform and nothing is handed to the
starting listeners.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.models import BridgeStartRefused

from .test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _service,
    _StubAdapter,
    _StubConfig,
)


async def _bridge(session_factory: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant)
        bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
        await session.commit()
    return tenant, bridge_id


async def test_a_refused_bridge_runs_nothing(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    tenant, bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)
    asked: list[dict[str, object]] = []
    handed: list[PlatformAdapter] = []

    async def refuse(**kwargs: object) -> None:
        asked.append(kwargs)
        raise BridgeStartRefused("not this tenant's")

    service.add_bridge_start_guard(refuse)
    service.add_bridge_starting_listener(handed.append)

    with pytest.raises(BridgeStartRefused):
        await service.start(bridge_id)

    assert asked == [
        {
            "bridge_id": bridge_id,
            "tenant_id": tenant,
            "bridge_type": "mattermost",
            "connection_config": {},
        }
    ]
    assert handed == []
    assert service.get_adapter(bridge_id) is None


async def test_a_bridge_every_guard_allows_starts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    _, bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)

    async def allow(**_: object) -> None: ...

    async def _run(*_: object) -> None: ...

    service._run_bridge = _run  # type: ignore[method-assign]
    service.add_bridge_start_guard(allow)

    await service.start(bridge_id)

    assert service.get_adapter(bridge_id) is not None
    await service.stop_all()


async def test_an_edit_can_be_checked_before_it_is_stored(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The edit route asks with the config it would store, not the old one."""
    service = _service(session_factory)
    seen: list[Mapping[str, object]] = []

    async def record(*, connection_config: Mapping[str, object], **_: object) -> None:
        seen.append(connection_config)

    service.add_bridge_start_guard(record)

    await service.check_start_guards(
        bridge_id="b",
        tenant_id="t",
        bridge_type="discord",
        connection_config={"guild_id": "2"},
    )

    assert seen == [{"guild_id": "2"}]


async def test_is_connected_is_false_until_the_bridge_finishes_starting(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """`_run_bridge` marks a bridge connected only once its adapter's `start`
    has returned and its own client loop is live, the moment traffic can
    safely reach it. Before that — and for a bridge nobody ever started — it
    is not."""
    _, bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)

    assert service.is_connected(bridge_id) is False

    async def _run(started_id: str, *_: object) -> None:
        service._connected.add(started_id)

    service._run_bridge = _run  # type: ignore[method-assign]

    await service.start(bridge_id)
    # `start` schedules the task and returns; let it run.
    await asyncio.sleep(0)

    assert service.is_connected(bridge_id) is True
    await service.stop_all()
