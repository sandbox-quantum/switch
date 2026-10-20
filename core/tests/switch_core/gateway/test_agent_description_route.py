"""The gateway route that changes an agent's description: owner-only, and a
blank description is refused rather than stored."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.agents import update_agent_description
from switch_core.gateway.schemas import UpdateAgentDescriptionRequest
from tests.switch_core.gateway.agent_route_harness import (
    add_agent,
    add_user,
    is_admin,
)


class _NoBridgeProtocol:
    """Stands in for AgentCore: these routes only tell it the agent changed."""

    async def update_bridge_identities(self, agent_id: str) -> list[str]:
        return []


_PROTOCOL = _NoBridgeProtocol()


_AGENT_STORE = AgentStore()


class TestUpdateAgentDescription:
    async def test_owner_changes_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            summary = await update_agent_description(
                agent.id,
                UpdateAgentDescriptionRequest(description="  Reviews PRs  "),
                session,
                _AGENT_STORE,
                _PROTOCOL,  # type: ignore[arg-type]
                owner,
                await is_admin(session, owner),
            )

            assert summary.description == "Reviews PRs"
            stored = await _AGENT_STORE.get(session, agent.id)
            assert stored is not None
            assert stored.description == "Reviews PRs"

    async def test_a_blank_one_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as refused:
                await update_agent_description(
                    agent.id,
                    UpdateAgentDescriptionRequest(description="   "),
                    session,
                    _AGENT_STORE,
                    _PROTOCOL,  # type: ignore[arg-type]
                    owner,
                    await is_admin(session, owner),
                )
            assert refused.value.status_code == 400

    async def test_only_the_owner_may(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            other = await add_user(session, name="other")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as refused:
                await update_agent_description(
                    agent.id,
                    UpdateAgentDescriptionRequest(description="Mine now"),
                    session,
                    _AGENT_STORE,
                    _PROTOCOL,  # type: ignore[arg-type]
                    other,
                    await is_admin(session, other),
                )
            assert refused.value.status_code == 403


class _RecordingProtocol:
    """Records which agents the route told the bridges about."""

    def __init__(self) -> None:
        self.updated: list[str] = []

    async def update_bridge_identities(self, agent_id: str) -> list[str]:
        self.updated.append(agent_id)
        return []


class TestBridgesHearOfTheChange:
    async def test_a_saved_change_is_passed_to_the_bridges(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        protocol = _RecordingProtocol()
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            await update_agent_description(
                agent.id,
                UpdateAgentDescriptionRequest(description="Writes up meetings"),
                session,
                _AGENT_STORE,
                protocol,  # type: ignore[arg-type]
                owner,
                await is_admin(session, owner),
            )

        assert protocol.updated == [agent.id]

    async def test_a_refused_change_is_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        protocol = _RecordingProtocol()
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException):
                await update_agent_description(
                    agent.id,
                    UpdateAgentDescriptionRequest(description="   "),
                    session,
                    _AGENT_STORE,
                    protocol,  # type: ignore[arg-type]
                    owner,
                    await is_admin(session, owner),
                )

        assert protocol.updated == []
