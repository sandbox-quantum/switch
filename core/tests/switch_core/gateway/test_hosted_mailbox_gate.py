"""The wake mailbox upkeep stays off on a server that does not run cloud agents."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent import hosted_mailbox
from switch_core.bridges.agent.hosted_mailbox import mailbox_upkeep
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import HostedWakeMailbox
from tests.switch_core.bridges.agent.protocol.registration_harness import make_service


@pytest.fixture
def expire(monkeypatch) -> AsyncMock:
    spy = AsyncMock(return_value=([], 0))
    monkeypatch.setattr(hosted_mailbox.HostedMailboxStore, "expire", spy)
    return spy


def _bare_service(session_factory):
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = SimpleNamespace(boot=1)
    service.config.hosted_controller_config_path = None
    service.config.hosted_launch_capacity = 0
    return service


async def test_unconfigured_server_with_no_hosted_work_skips_the_pass(
    session_factory, expire
):
    await mailbox_upkeep(_bare_service(session_factory), datetime.now(UTC))

    expire.assert_not_awaited()


async def test_unconfigured_server_still_tends_retained_hosted_work(
    session_factory, expire
):
    now = datetime.now(UTC)
    async with session_factory() as session:
        session.add(
            HostedWakeMailbox(
                agent_id="00000000-0000-4000-8000-00000000000a",
                room_id="room-1",
                message_id="$m1",
                event={},
                addressed_at=now,
                updated_at=now,
                expires_at=now + timedelta(hours=24),
            )
        )
        await session.commit()

    await mailbox_upkeep(_bare_service(session_factory), datetime.now(UTC))

    expire.assert_awaited_once()


@pytest.mark.parametrize(
    ("controller", "capacity"),
    [("/etc/switch/controller.json", 0), (None, 1)],
)
async def test_configured_server_runs_the_pass(
    session_factory, expire, controller, capacity
):
    service = _bare_service(session_factory)
    service.config.hosted_controller_config_path = controller
    service.config.hosted_launch_capacity = capacity

    await mailbox_upkeep(service, datetime.now(UTC))

    expire.assert_awaited_once()
