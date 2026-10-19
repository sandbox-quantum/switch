"""Handing a started bridge the operator's `THIRD_PARTY_AVATARS_ENABLED`.

The adapter withholds third-party avatars until it is told otherwise, and the
lifecycle service is the one thing that tells it. Dropping that call would make
every deployment lose its generated icons; passing the wrong value would send
names an operator turned off. Either way, it has to be the config's value that
arrives.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.agent_icon import generated_icon_url
from switch_core.bridges.collaboration.adapter import PlatformAdapter

from .test_lifecycle_tenant_binding import (
    _make_bridge,
    _make_tenant,
    _service,
    _StubAdapter,
    _StubConfig,
)


@pytest.mark.parametrize(
    ("enabled", "expected"),
    [(True, generated_icon_url("worker")), (False, None)],
    ids=["on", "off"],
)
async def test_a_started_bridge_follows_the_setting(
    session_factory: async_sessionmaker[AsyncSession],
    enabled: bool,
    expected: str | None,
) -> None:
    tenant = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        await _make_tenant(session, tenant)
        bridge_id, _ = await _make_bridge(session, tenant_id=tenant)
        await session.commit()

    service = _service(session_factory)
    service._config.third_party_avatars_enabled = enabled
    built: list[_StubAdapter] = []

    class _Recording(_StubAdapter):
        def __init__(self, *, config: Any) -> None:
            PlatformAdapter.__init__(self)
            super().__init__(config=config)
            built.append(self)

    service.register_adapter("mattermost", _Recording, _StubConfig)

    async def _run(bridge_id: str, tenant_id: str, *_: object) -> None:
        return None

    service._run_bridge = _run  # type: ignore[method-assign]

    try:
        await service.start(bridge_id)
        assert await built[0].agent_icon_url("worker") == expected
    finally:
        await service.stop_all()
