"""Roster changes are gated on membership, not public write_visibility (security).

Before this fix invite_agent_to_room / add_users_to_room authorized via
``_require_room_action(..., "write")``, and a room's write_visibility defaults to
"public", so any agent could add itself to any default-visibility room owned by
another tenant and unlock the member-gated ops (read context, post, tasks): a
cross-tenant room takeover. These tests pin the new rule: only the room's owner,
an admin, or an existing member may change the roster.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.service import ProtocolService
from switch_core.bridges.agent.protocol.types import (
    IntegrationProfile,
    TaskProtocolConfig,
)
from switch_core.db.models import Client, Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.room_store import RoomStore

_PROFILE = IntegrationProfile(
    connection_model="session_passive",
    message_exchange=True,
    pre_invocation_mediation=[],
    post_invocation_mediation=[],
    event_reporting=[],
    task_protocol=TaskProtocolConfig(can_delegate=False, can_accept=False),
)


class _FakeClientLifecycle:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def create_client(self, *, client_type: str, display_name: str) -> Client:
        async with self._session_factory() as session:
            client = Client(
                matrix_user_id=f"@{display_name}:test",
                display_name=display_name,
                type=client_type,
            )
            session.add(client)
            await session.commit()
            return client

    def start_client(self, client: Client) -> None:
        pass


class _NoBridges:
    def all_bridges(self) -> list[object]:
        return []


def _service(session_factory: async_sessionmaker[AsyncSession]) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.session_factory = session_factory  # type: ignore[attr-defined]
    svc.agent_store = AgentStore()  # type: ignore[attr-defined]
    svc.api_key_store = ApiKeyStore()  # type: ignore[attr-defined]
    svc.room_store = RoomStore()  # type: ignore[attr-defined]
    svc.client_lifecycle = _FakeClientLifecycle(session_factory)  # type: ignore[attr-defined]
    svc.collab_lifecycle = _NoBridges()  # type: ignore[attr-defined]
    svc.config = SimpleNamespace(jwt_secret_key="test-secret")  # type: ignore[attr-defined]
    return svc


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    role: str = "user",
) -> str:
    async with session_factory() as session:
        user = User(name=name, email=f"{name}@test", role=role, password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


async def _register(svc: ProtocolService, name: str, owner_id: str) -> str:
    result = await svc.register_agent(
        name=name,
        description=f"{name} desc",
        connector_type="test",
        integration_profile=_PROFILE,
        owner_id=owner_id,
    )
    return result.agent_id


async def _make_public_room(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    owner_id: str,
    member_agent_ids: list[str],
) -> str:
    async with session_factory() as session:
        room = Room(
            matrix_room_id="!secret:test",
            name="secret",
            description="",
            owner_id=owner_id,
            read_visibility="public",
            write_visibility="public",
        )
        session.add(room)
        await session.flush()
        if member_agent_ids:
            await RoomStore().add_agents(session, room.id, member_agent_ids)
        await session.commit()
        return room.id


class TestRoomRosterAuthz:
    async def test_non_member_other_tenant_cannot_change_roster(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        victim = await _make_user(session_factory, "victim")
        attacker = await _make_user(session_factory, "attacker")
        victim_agent = await _register(svc, "victim-agent", victim)
        attacker_agent = await _register(svc, "attacker-agent", attacker)
        room_id = await _make_public_room(
            session_factory, owner_id=victim, member_agent_ids=[victim_agent]
        )

        async with session_factory() as session:
            with pytest.raises(PermissionError):
                await svc._require_room_roster_change(session, attacker_agent, room_id)

    async def test_member_can_change_roster(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        victim = await _make_user(session_factory, "victim")
        victim_agent = await _register(svc, "victim-agent", victim)
        room_id = await _make_public_room(
            session_factory, owner_id=victim, member_agent_ids=[victim_agent]
        )

        async with session_factory() as session:
            room = await svc._require_room_roster_change(session, victim_agent, room_id)
            assert room.id == room_id

    async def test_owner_non_member_can_change_roster(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        victim = await _make_user(session_factory, "victim")
        member_agent = await _register(svc, "member-agent", victim)
        owner_other_agent = await _register(svc, "owner-other-agent", victim)
        room_id = await _make_public_room(
            session_factory, owner_id=victim, member_agent_ids=[member_agent]
        )

        async with session_factory() as session:
            # Same owner, different (non-member) agent still passes via ownership.
            room = await svc._require_room_roster_change(
                session, owner_other_agent, room_id
            )
            assert room.id == room_id

    async def test_admin_non_member_can_change_roster(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        svc = _service(session_factory)
        victim = await _make_user(session_factory, "victim")
        admin = await _make_user(session_factory, "root", role="admin")
        victim_agent = await _register(svc, "victim-agent", victim)
        admin_agent = await _register(svc, "admin-agent", admin)
        room_id = await _make_public_room(
            session_factory, owner_id=victim, member_agent_ids=[victim_agent]
        )

        async with session_factory() as session:
            room = await svc._require_room_roster_change(session, admin_agent, room_id)
            assert room.id == room_id
