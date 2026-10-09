"""`start_all` reads every agent row once per tenant and hands each consumer
its own, so no agent client queries for itself at boot."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.client_lifecycle_service import ClientLifecycleService
from switch_core.db.models import Agent
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.tenant_store import TenantStore
from tests.switch_core.test_room_wide_mention_wakes_no_agent import _make_agent


class _Consumer:
    def __init__(self) -> None:
        self.display_name = "agent"
        self.transport_user_id = "@agent:test"
        self.preloaded: Agent | None = None

    def preload_agent(self, agent: Agent) -> None:
        self.preloaded = agent

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


class _Factory:
    def __init__(self) -> None:
        self.consumers: dict[str, _Consumer] = {}

    def create(self, record: Any) -> tuple[_Consumer, _Consumer]:
        consumer = _Consumer()
        self.consumers[record.id] = consumer
        return consumer, consumer


async def test_each_agent_consumer_gets_its_own_row_before_it_starts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        agents = [await _make_agent(session, f"pre-{n}") for n in range(3)]
        await session.commit()
    factory = _Factory()
    service = ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=factory,  # type: ignore[arg-type]
        session_factory=session_factory,
        config=MagicMock(),
        tenants_isolated=True,
    )

    await service.start_all()

    for agent in agents:
        preloaded = factory.consumers[agent.client_id].preloaded
        assert preloaded is not None and preloaded.id == agent.id


async def test_a_failed_bulk_read_still_starts_every_client(
    session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The bulk read is an optimisation: when it fails, each client starts
    without a preload and reads its own row, instead of none starting."""
    async with session_factory() as session:
        agents = [await _make_agent(session, f"nopre-{n}") for n in range(2)]
        await session.commit()
    factory = _Factory()
    service = ClientLifecycleService(
        provisioning=MagicMock(),
        client_store=ClientStore(),
        tenant_store=TenantStore(),
        client_factory=factory,  # type: ignore[arg-type]
        session_factory=session_factory,
        config=MagicMock(),
        tenants_isolated=True,
    )

    async def _fail(_records: Any) -> dict[str, Agent]:
        raise PoolTimeoutError("QueuePool limit reached")

    monkeypatch.setattr(service, "_agents_by_client_id", _fail)

    await service.start_all()

    for agent in agents:
        assert agent.client_id in factory.consumers
        assert factory.consumers[agent.client_id].preloaded is None
