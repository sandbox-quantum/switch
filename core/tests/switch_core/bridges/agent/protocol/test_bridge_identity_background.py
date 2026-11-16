"""Registering an agent does not wait on the messaging apps.

Each bridge gives the new agent its platform identity in a background task
with its own deadline, so a messaging app that is slow or not answering
cannot hold the registration past the caller's wait. The identity follows
when the app answers; one the deadline cut off is left to the bridge's own
identity sync.
"""

from __future__ import annotations

import asyncio
import logging
import time

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol import agent_core
from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.db.models import TENANT_ZERO_ID
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
    register,
)


class _HangingAdapter:
    """A platform that does not answer until `recover` is called."""

    def __init__(self) -> None:
        self.answering = asyncio.Event()
        self.created: list[str] = []

    def recover(self) -> None:
        self.answering.set()

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        await self.answering.wait()
        self.created.append(agent.name)


class _QuickAdapter:
    def __init__(self) -> None:
        self.created: list[str] = []

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        self.created.append(agent.name)


class _Bridge:
    def __init__(self, adapter: object) -> None:
        self.tenant_id = TENANT_ZERO_ID
        self.adapter = adapter


class _Bridges:
    def __init__(self, bridges: list[_Bridge]) -> None:
        self._bridges = bridges

    def bridges_for_tenant(self, tenant_id: str) -> list[_Bridge]:
        return [b for b in self._bridges if b.tenant_id == tenant_id]


async def _settle() -> None:
    await asyncio.gather(*agent_core._identity_tasks, return_exceptions=True)


class TestRegistrationDoesNotWaitOnBridges:
    async def test_a_bridge_that_hangs_does_not_hold_up_registration(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        hanging = _HangingAdapter()
        quick = _QuickAdapter()
        svc = make_service(session_factory)
        svc.collab_lifecycle = _Bridges([_Bridge(hanging), _Bridge(quick)])  # type: ignore[assignment]
        owner = await make_owner(session_factory)

        started = time.monotonic()
        agent_id = await asyncio.wait_for(register(svc, "slow-app-bot", owner), 1.0)

        assert time.monotonic() - started < 1.0
        async with session_factory() as session:
            assert await svc.agent_store.get(session, agent_id) is not None
        await asyncio.sleep(0)
        assert quick.created == ["slow-app-bot"]
        assert hanging.created == []

        hanging.recover()
        await _settle()

        assert hanging.created == ["slow-app-bot"]

    async def test_a_bridge_past_its_deadline_is_logged_and_left_to_its_sync(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setattr(agent_core, "BRIDGE_IDENTITY_CREATE_TIMEOUT_S", 0.05)
        hanging = _HangingAdapter()
        svc = make_service(session_factory)
        svc.collab_lifecycle = _Bridges([_Bridge(hanging)])  # type: ignore[assignment]
        owner = await make_owner(session_factory)

        with caplog.at_level(logging.WARNING, logger=agent_core.logger.name):
            agent_id = await register(svc, "never-answered", owner)
            await _settle()

        assert hanging.created == []
        assert "Failed to create bridge identity for never-answered" in caplog.text
        async with session_factory() as session:
            assert await svc.agent_store.get(session, agent_id) is not None
