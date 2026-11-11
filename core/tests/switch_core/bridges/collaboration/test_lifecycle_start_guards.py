"""A start guard can stop a bridge before any of it runs.

Guards answer what a bridge's own config cannot: whether the workspace it
names is its tenant's. A refusal has to come before the adapter is built, so a
refused bridge never reaches its platform and nothing is handed to the
starting listeners.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Mapping

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration import lifecycle_service as lifecycle_module
from switch_core.bridges.collaboration.adapter import PlatformAdapter
from switch_core.bridges.collaboration.models import BridgeStartRefused
from switch_core.db.models import CollaborationBridge

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


async def test_a_refused_take_over_is_said_once_and_not_tried_again_until_changed(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A bridge a guard refuses (a host that no longer resolves, say) does not
    fix itself. Taken over again from the same row, it is not tried, and only
    the first refusal is logged as an error, with no stack trace; a restart or
    an edit tries it again."""
    _, bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)
    asked: list[str] = []

    async def refuse(**kwargs: object) -> None:
        asked.append(str(kwargs["bridge_id"]))
        raise BridgeStartRefused("switch-mattermost does not resolve")

    service.add_bridge_start_guard(refuse)
    fence = object()

    with caplog.at_level(logging.DEBUG, logger=lifecycle_module.__name__):
        await service._take_over(bridge_id, fence)  # type: ignore[arg-type]
        await service._take_over(bridge_id, fence)  # type: ignore[arg-type]

    assert asked == [bridge_id]
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1
    assert "does not resolve" in errors[0].getMessage()
    assert errors[0].exc_info is None
    # `register` still learns why its bridge could not start.
    assert isinstance(service._failed_take_overs[bridge_id], BridgeStartRefused)

    with pytest.raises(BridgeStartRefused):
        await service.restart(bridge_id)
    assert asked == [bridge_id, bridge_id]

    async with session_factory() as session:
        await session.execute(
            update(CollaborationBridge)
            .where(CollaborationBridge.id == bridge_id)
            .values(display_name="renamed")
        )
        await session.commit()
    await service._take_over(bridge_id, fence)  # type: ignore[arg-type]
    assert asked == [bridge_id, bridge_id, bridge_id]


async def test_a_quiet_copy_refused_after_a_hand_over_is_a_warning_not_a_trace(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    _, bridge_id = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _StubAdapter, _StubConfig)

    async def refuse(**_: object) -> None:
        raise BridgeStartRefused("switch-mattermost does not resolve")

    service.add_bridge_start_guard(refuse)
    service._owned.want(bridge_id)

    with caplog.at_level(logging.DEBUG, logger=lifecycle_module.__name__):
        service._start_quietly(bridge_id)
        await asyncio.gather(*service._quiet_starts.values())

    refusals = [r for r in caplog.records if "cannot start here" in r.getMessage()]
    assert [r.levelno for r in refusals] == [logging.WARNING]
    assert refusals[0].exc_info is None
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


async def test_a_restart_elsewhere_tries_a_bridge_refused_here_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """A restart leaves the row as it was, so it is announced as a restart:
    a process that saw the bridge refused tries it again rather than reading
    the unchanged row as nothing to do."""
    _, bridge_id = await _bridge(session_factory)
    here = _service(session_factory)
    elsewhere = _service(session_factory)
    asked: list[str] = []
    for service in (here, elsewhere):
        service.register_adapter("mattermost", _StubAdapter, _StubConfig)

    async def refuse(**kwargs: object) -> None:
        asked.append(str(kwargs["bridge_id"]))
        raise BridgeStartRefused("switch-mattermost does not resolve")

    elsewhere.add_bridge_start_guard(refuse)
    fence = object()
    await elsewhere._take_over(bridge_id, fence)  # type: ignore[arg-type]
    await elsewhere._take_over(bridge_id, fence)  # type: ignore[arg-type]
    assert asked == [bridge_id]

    announced: list[str] = []

    class _Signals:
        def restarted(self, bridge_id: str) -> None:
            announced.append(bridge_id)

    here.use_signals(_Signals())  # type: ignore[arg-type]
    await here.restart(bridge_id)
    assert announced == [bridge_id]

    await elsewhere.restarted_elsewhere(bridge_id)
    assert asked == [bridge_id, bridge_id]
    await here.stop(bridge_id)


class _SharedWorkspaceAdapter(_StubAdapter):
    @classmethod
    def claimed_workspace(cls, connection_config: dict[str, object]) -> str | None:
        return "T-shared"


async def test_bridges_sharing_a_workspace_are_reported_once_and_not_as_a_warning(
    session_factory: async_sessionmaker[AsyncSession],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Pilot runs several tenants on one Slack workspace on purpose."""
    _, first = await _bridge(session_factory)
    _, second = await _bridge(session_factory)
    service = _service(session_factory)
    service.register_adapter("mattermost", _SharedWorkspaceAdapter, _StubConfig)

    async def _run(*_: object) -> None: ...

    service._run_bridge = _run  # type: ignore[method-assign]
    caplog.set_level("DEBUG", logger="switch_core.bridges.collaboration")

    await service.start(first)
    await service.start(second)
    await service.stop(second)
    await service.start(second)

    shared = [r for r in caplog.records if "also connects" in r.getMessage()]
    assert [r.levelname for r in shared] == ["INFO"]
    await service.stop_all()
