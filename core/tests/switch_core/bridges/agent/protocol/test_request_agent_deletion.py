"""An agent asking for another agent to be deleted.

An agent may ask, never decide: the request is posted in the room and waits
for a person to confirm it (see test_commands_rename_delete.py for the
confirming side). These pin what an agent may ask for, that asking deletes
nothing, and that the ask is visible in the room and in the audit log.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.protocol.agent_core import AgentRenameRefused
from switch_core.clients.actor import SystemActor
from switch_core.clients.agent_admin import AgentDeletionRequests
from switch_core.db.models import Agent, AuditEvent, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    FakeClientLifecycle,
    make_owner,
    make_service,
    register,
)


class _Lifecycle(FakeClientLifecycle):
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(session_factory)
        self.posted: list[tuple[str, str]] = []
        admin = object.__new__(SystemActor)

        async def send_admin(room_id: str, body: str, **_kw: Any) -> None:
            self.posted.append((room_id, body))

        admin.send_admin = send_admin  # type: ignore[method-assign]
        self._admin = admin

    def get_by_type(self, client_type: str, tenant_id: str) -> list[Any]:
        return [self._admin] if client_type == "admin" else []


async def _setup(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[Any, _Lifecycle, str, str, str, str]:
    svc = make_service(session_factory)
    lifecycle = _Lifecycle(session_factory)
    svc.client_lifecycle = lifecycle  # type: ignore[assignment]
    svc.room_store = RoomStore()
    svc.deletion_requests = AgentDeletionRequests()
    owner = await make_owner(session_factory)
    caller = await register(svc, "helper", owner)
    target = await register(svc, "notes-taker", owner)
    async with session_factory() as session:
        room = Room(transport_room_id="!ops:test", name="ops", description="ops")
        session.add(room)
        await session.commit()
        room_id = room.id
    return svc, lifecycle, owner, caller, target, room_id


async def _set(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str, **columns: Any
) -> None:
    async with session_factory() as session:
        await AgentStore().update(session, agent_id, **columns)
        await session.commit()


class TestAsking:
    async def test_asking_deletes_nothing_and_says_so_in_the_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, lifecycle, _owner, caller, target, room_id = await _setup(session_factory)

        name = await svc.request_agent_deletion(
            caller_agent_id=caller, target_agent_id=target, room_id=room_id
        )

        assert name == "notes-taker"
        async with session_factory() as session:
            assert await session.get(Agent, target) is not None
        assert lifecycle.posted[0][0] == "!ops:test"
        assert "asks to delete" in lifecycle.posted[0][1]
        assert "`!delete-agent notes-taker confirm`" in lifecycle.posted[0][1]
        assert svc.deletion_requests.take(room_id, target) is not None

    async def test_the_ask_is_in_the_audit_log(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, _lifecycle, _owner, caller, target, room_id = await _setup(session_factory)

        await svc.request_agent_deletion(
            caller_agent_id=caller, target_agent_id=target, room_id=room_id
        )

        async with session_factory() as session:
            event = (
                await session.execute(
                    select(AuditEvent).where(
                        AuditEvent.action == "agent.deletion_requested"
                    )
                )
            ).scalar_one()
        assert event.target_id == target
        assert event.details["requested_by_agent_name"] == "helper"


class TestRefused:
    async def test_itself(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, lifecycle, _owner, caller, _target, room_id = await _setup(session_factory)

        with pytest.raises(AgentRenameRefused, match="its own deletion"):
            await svc.request_agent_deletion(
                caller_agent_id=caller, target_agent_id=caller, room_id=room_id
            )
        assert lifecycle.posted == []

    async def test_an_agent_that_can_manage_agents(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, lifecycle, _owner, caller, target, room_id = await _setup(session_factory)
        await _set(session_factory, target, can_manage_agents=True)

        with pytest.raises(AgentRenameRefused, match="can manage agents itself"):
            await svc.request_agent_deletion(
                caller_agent_id=caller, target_agent_id=target, room_id=room_id
            )
        assert lifecycle.posted == []

    async def test_another_owners_agent(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc, lifecycle, _owner, caller, _target, room_id = await _setup(session_factory)
        async with session_factory() as session:
            other = User(
                name="other", email="other@test", role="user", password_hash="x"
            )
            session.add(other)
            await session.commit()
            other_id = other.id
        foreign = await register(svc, "foreign", other_id)

        with pytest.raises(PermissionError):
            await svc.request_agent_deletion(
                caller_agent_id=caller, target_agent_id=foreign, room_id=room_id
            )
        assert lifecycle.posted == []


class TestTheTool:
    def _bind(
        self, monkeypatch: pytest.MonkeyPatch, svc: Any, caller: str, room_id: str
    ) -> None:
        async def room() -> str:
            return room_id

        monkeypatch.setattr(definitions, "get_agent_id", lambda: caller)
        monkeypatch.setattr(definitions, "get_protocol", lambda: svc)
        monkeypatch.setattr(definitions, "require_connected_room", room)

    async def test_it_needs_can_manage_agents(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        svc, lifecycle, _owner, caller, target, room_id = await _setup(session_factory)
        self._bind(monkeypatch, svc, caller, room_id)

        async def refused() -> Any:
            raise PermissionError("Agent helper is not allowed to manage agents.")

        monkeypatch.setattr(definitions, "permitted_to_manage", refused)

        with pytest.raises(PermissionError, match="not allowed to manage agents"):
            await definitions.request_agent_deletion(target)
        assert lifecycle.posted == []
        assert svc.deletion_requests.take(room_id, target) is None

    async def test_it_says_what_the_person_must_send(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        svc, _lifecycle, _owner, caller, target, room_id = await _setup(session_factory)
        self._bind(monkeypatch, svc, caller, room_id)

        async def allowed() -> Any:
            return None

        monkeypatch.setattr(definitions, "permitted_to_manage", allowed)

        result = await definitions.request_agent_deletion(target)

        assert result == {
            "agent_name": "notes-taker",
            "status": "awaiting_confirmation",
            "confirm_with": "!delete-agent notes-taker confirm",
            "expires_in_seconds": 120,
        }

    async def test_a_refusal_is_a_client_error(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        svc, _lifecycle, _owner, caller, _target, room_id = await _setup(
            session_factory
        )
        self._bind(monkeypatch, svc, caller, room_id)

        async def allowed() -> Any:
            return None

        monkeypatch.setattr(definitions, "permitted_to_manage", allowed)

        with pytest.raises(ValueError, match="its own deletion"):
            await definitions.request_agent_deletion(caller)
