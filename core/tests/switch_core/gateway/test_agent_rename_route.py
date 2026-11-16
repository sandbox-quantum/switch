"""The gateway route that renames an agent.

Only the owner or an admin may rename, and each refusal from the rename maps
to the status a client can act on: 409 for a name another agent has, 400 for
everything the person has to change. What the rename could not do is passed
back rather than dropped.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol import agent_core
from switch_core.bridges.agent.protocol.agent_core import (
    AgentExistsError,
    AgentRenameRefused,
    AgentRenameResult,
)
from switch_core.bridges.collaboration.adapter import AgentIdentity
from switch_core.db.models import User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.agents import rename_agent
from switch_core.gateway.schemas import RenameAgentRequest
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)
from tests.switch_core.gateway.agent_route_harness import (
    add_agent,
    add_user,
    is_admin,
)

_AGENT_STORE = AgentStore()


class _Protocol:
    def __init__(
        self, session_factory: async_sessionmaker[AsyncSession], error: Exception | None
    ) -> None:
        self._session_factory = session_factory
        self._error = error
        self.calls: list[tuple[str, str, str | None]] = []

    async def rename_agent(
        self, *, agent_id: str, new_name: str, display_name: str | None
    ) -> AgentRenameResult:
        self.calls.append((agent_id, new_name, display_name))
        if self._error is not None:
            raise self._error
        async with self._session_factory() as session:
            agent = await _AGENT_STORE.get(session, agent_id)
            assert agent is not None
            old = agent.name
            await _AGENT_STORE.update(
                session, agent_id, name=new_name, display_name=display_name
            )
            await session.commit()
        return AgentRenameResult(
            agent_id=agent_id,
            old_name=old,
            new_name=new_name,
            display_name=display_name,
            bridge_failures=["slack: Slack is down"],
            templates_mentioning_old_name=["weekly"],
        )


class _UnansweringAdapter:
    """A messaging app that has stopped answering."""

    async def create_agent_identity(self, agent: AgentIdentity) -> None:
        return None

    async def check_agent_identity_name(self, agent_id: str, new_name: str) -> None:
        await asyncio.Event().wait()

    async def rename_agent_identity(self, old_name: str, agent: AgentIdentity) -> None:
        await asyncio.Event().wait()


class _UnansweringBridge:
    bridge_type = "mattermost"
    adapter = _UnansweringAdapter()


class _ClientLifecycle(FakeClientLifecycle):
    def get(self, client_id: str) -> None:
        return None


class _Bridges:
    def __init__(self) -> None:
        self._bridges = [_UnansweringBridge()]

    def bridges_for_tenant(self, tenant_id: str) -> list[_UnansweringBridge]:
        return self._bridges


class TestRenameAgentRoute:
    async def test_a_messaging_app_not_answering_still_renames(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The route answers 200 with the app listed as behind, never a 500,
        when an app does not answer the rename's handle check."""
        monkeypatch.setattr(agent_core, "BRIDGE_RENAME_CHECK_TIMEOUT_S", 0.1)
        protocol = make_service(session_factory)
        protocol.collab_lifecycle = _Bridges()  # type: ignore[assignment]
        protocol.client_lifecycle = _ClientLifecycle(session_factory)  # type: ignore[assignment]
        protocol.room_store = RoomStore()
        protocol.room_role_store = RoomRoleStore()
        owner_id = await make_owner(session_factory)
        agent_id = await register(protocol, "flint-tracker", owner_id)

        async with session_factory() as session:
            owner = await session.get(User, owner_id)
            assert owner is not None
            response = await asyncio.wait_for(
                rename_agent(
                    agent_id,
                    RenameAgentRequest(name="flint-scout", display_name=None),
                    session,
                    _AGENT_STORE,
                    protocol,
                    owner,
                    await is_admin(session, owner),
                ),
                5.0,
            )

        assert response.agent.name == "flint-scout"
        assert response.bridge_failures == [
            "mattermost: it did not answer in time, and will be updated when it answers"
        ]

    async def test_the_owner_renames_and_hears_what_is_outstanding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        protocol = _Protocol(session_factory, None)
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            response = await rename_agent(
                agent.id,
                RenameAgentRequest(name="switch-dev", display_name="Switch Dev"),
                session,
                _AGENT_STORE,
                protocol,  # type: ignore[arg-type]
                owner,
                await is_admin(session, owner),
            )

        assert response.agent.name == "switch-dev"
        assert response.agent.display_name == "Switch Dev"
        assert protocol.calls == [(agent.id, "switch-dev", "Switch Dev")]
        assert response.old_name == "switchdev"
        assert response.bridge_failures == ["slack: Slack is down"]
        assert response.templates_mentioning_old_name == ["weekly"]

    async def test_someone_else_cannot_rename_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        protocol = _Protocol(session_factory, None)
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            stranger = await add_user(session, name="stranger")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await rename_agent(
                    agent.id,
                    RenameAgentRequest(name="mine-now", display_name=None),
                    session,
                    _AGENT_STORE,
                    protocol,  # type: ignore[arg-type]
                    stranger,
                    await is_admin(session, stranger),
                )

        assert exc.value.status_code == 403
        assert protocol.calls == []

    @pytest.mark.parametrize(
        "error,status",
        [
            (AgentExistsError("Agent already exists: 'taken'."), 409),
            (AgentRenameRefused("'taken' is a role in room 'ops'."), 400),
            (ValueError("Invalid agent name: 'Bad Name'."), 400),
        ],
    )
    async def test_refusals_map_to_statuses(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        error: Exception,
        status: int,
    ) -> None:
        protocol = _Protocol(session_factory, error)
        async with session_factory() as session:
            owner = await add_user(session, name="owner")
            agent = await add_agent(session, name="switchdev", owner_id=owner.id)

            with pytest.raises(HTTPException) as exc:
                await rename_agent(
                    agent.id,
                    RenameAgentRequest(name="taken", display_name=None),
                    session,
                    _AGENT_STORE,
                    protocol,  # type: ignore[arg-type]
                    owner,
                    await is_admin(session, owner),
                )

        assert exc.value.status_code == status
        assert exc.value.detail == str(error)

    async def test_an_unknown_agent_is_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        protocol = _Protocol(session_factory, None)
        async with session_factory() as session:
            owner = await add_user(session, name="owner")

            with pytest.raises(HTTPException) as exc:
                await rename_agent(
                    "no-such-agent",
                    RenameAgentRequest(name="x", display_name=None),
                    session,
                    _AGENT_STORE,
                    protocol,  # type: ignore[arg-type]
                    owner,
                    await is_admin(session, owner),
                )

        assert exc.value.status_code == 404
