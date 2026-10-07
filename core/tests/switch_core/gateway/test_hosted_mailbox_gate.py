"""The wake mailbox upkeep stays off on a server that does not run cloud agents."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.bridges.agent import hosted_mailbox
from switch_core.bridges.agent.hosted_mailbox import mailbox_upkeep
from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from tests.switch_core.bridges.agent.protocol.registration_harness import make_service
from tests.switch_core.connections.github_seed import github_vendor  # noqa: F401
from tests.switch_core.gateway.test_hosted_workers import worker_app  # noqa: F401


@pytest.fixture
def reclaim(monkeypatch) -> AsyncMock:
    spy = AsyncMock(return_value=0)
    monkeypatch.setattr(hosted_mailbox.HostedMailboxStore, "reclaim", spy)
    return spy


def _unconfigured(config) -> None:
    config.hosted_controller_config_path = None
    config.hosted_launch_capacity = 0


def _bare_service(session_factory):
    service = make_service(session_factory)
    service.connections = AgentConnectionRegistry()
    service.event_buffer = SimpleNamespace(boot=1)
    _unconfigured(service.config)
    return service


async def test_unconfigured_server_with_no_hosted_work_skips_the_pass(
    session_factory, reclaim
):
    await mailbox_upkeep(_bare_service(session_factory), datetime.now(UTC))

    reclaim.assert_not_awaited()


async def test_unconfigured_server_still_tends_retained_hosted_work(
    worker_app,  # noqa: F811
    reclaim,
):
    _, _, _, service, _, _ = worker_app
    _unconfigured(service.config)

    await mailbox_upkeep(service, datetime.now(UTC))

    reclaim.assert_awaited_once()


@pytest.mark.parametrize(
    ("controller", "capacity"),
    [("/etc/switch/controller.json", 0), (None, 1)],
)
async def test_configured_server_runs_the_pass(
    session_factory, reclaim, controller, capacity
):
    service = _bare_service(session_factory)
    service.config.hosted_controller_config_path = controller
    service.config.hosted_launch_capacity = capacity

    await mailbox_upkeep(service, datetime.now(UTC))

    reclaim.assert_awaited_once()
