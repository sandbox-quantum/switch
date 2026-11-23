"""Room and agent changes recorded in the audit log, in the transaction of the
change: memberships, archiving, and an agent registering."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import AuditAction
from switch_core.db.models import Agent, AuditEvent, Client
from switch_core.db.stores.room_store import RoomStore
from switch_core.logging_context import log_context
from switch_core.room_service import RoomService
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _PROFILE,
    _make_public_room,
    _make_user,
    _register,
    _service,
)


async def _events(
    session_factory: async_sessionmaker[AsyncSession], action: AuditAction
) -> list[AuditEvent]:
    async with session_factory() as session:
        return list(
            (
                await session.execute(
                    select(AuditEvent)
                    .where(AuditEvent.action == action.value)
                    .order_by(AuditEvent.occurred_at)
                )
            )
            .scalars()
            .all()
        )


async def _client(
    session_factory: async_sessionmaker[AsyncSession],
    client_type: str,
    *,
    user_id: str | None,
) -> str:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@{client_type}-client:test",
            display_name=f"{client_type} client",
            type=client_type,
            user_id=user_id,
        )
        session.add(client)
        await session.commit()
        return client.id


class TestMembership:
    async def test_an_agent_joining_and_leaving_is_recorded_once_each(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_user(session_factory, "owner")
        agent_id = await _register(_service(session_factory), "joiner", owner)
        room_id = await _make_public_room(
            session_factory, owner_id=owner, member_agent_ids=[]
        )
        async with session_factory() as session:
            client_id = await _agent_id_client(session, agent_id)
            with log_context(user_id=owner):
                assert await RoomStore().add_client(session, client_id, room_id)
                assert not await RoomStore().add_client(session, client_id, room_id)
            await session.commit()
        async with session_factory() as session:
            assert await RoomStore().remove_client(session, client_id, room_id)
            await session.commit()

        [added] = await _events(session_factory, AuditAction.ROOM_MEMBER_ADDED)
        assert added.target_type == "room"
        assert added.target_id == room_id
        assert added.actor_user_id == owner
        assert added.details == {
            "client_type": "agent",
            "client_id": client_id,
            "agent_id": agent_id,
            "agent_name": "joiner",
        }
        [removed] = await _events(session_factory, AuditAction.ROOM_MEMBER_REMOVED)
        assert removed.actor_user_id is None
        assert removed.details is not None
        assert removed.details["agent_id"] == agent_id

    async def test_a_person_in_console_is_recorded_and_a_bridge_is_not(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        person = await _make_user(session_factory, "person")
        member = await _client(session_factory, "member", user_id=person)
        bridge = await _client(session_factory, "bridge", user_id=None)
        room_id = await _make_public_room(
            session_factory, owner_id=person, member_agent_ids=[]
        )
        async with session_factory() as session:
            await RoomStore().add_client(session, member, room_id)
            await RoomStore().add_client(session, bridge, room_id)
            await session.commit()

        [added] = await _events(session_factory, AuditAction.ROOM_MEMBER_ADDED)
        assert added.details == {
            "client_type": "member",
            "client_id": member,
            "user_id": person,
        }

    async def test_a_membership_that_rolls_back_leaves_no_event(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        person = await _make_user(session_factory, "person")
        member = await _client(session_factory, "member", user_id=person)
        room_id = await _make_public_room(
            session_factory, owner_id=person, member_agent_ids=[]
        )
        async with session_factory() as session:
            await RoomStore().add_client(session, member, room_id)
            await session.rollback()

        assert await _events(session_factory, AuditAction.ROOM_MEMBER_ADDED) == []


class _Listeners:
    def invalidate(self, *_: Any) -> None:
        return None

    def invalidate_agent(self, *_: Any) -> None:
        return None


def _room_service(session_factory: async_sessionmaker[AsyncSession]) -> RoomService:
    unused: Any = object()
    return RoomService(
        provisioning=unused,
        room_store=RoomStore(),
        agent_store=unused,
        client_lifecycle=unused,
        collab_lifecycle=unused,
        collab_bridge_store=unused,
        resource_service=unused,
        session_factory=session_factory,
        room_cache=_Listeners(),  # type: ignore[arg-type]
    )


class TestArchive:
    async def test_archiving_and_unarchiving_are_recorded_for_the_caller(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_user(session_factory, "owner")
        room_id = await _make_public_room(
            session_factory, owner_id=owner, member_agent_ids=[]
        )
        service = _room_service(session_factory)

        with log_context(user_id=owner):
            await service.set_room_archived(room_id, True)
            await service.set_room_archived(room_id, True)
            await service.set_room_archived(room_id, False)

        [archived] = await _events(session_factory, AuditAction.ROOM_ARCHIVED)
        assert archived.target_id == room_id
        assert archived.actor_user_id == owner
        assert archived.details == {"name": "secret", "acting_agent_id": None}
        [unarchived] = await _events(session_factory, AuditAction.ROOM_UNARCHIVED)
        assert unarchived.target_id == room_id


class _Provisioning:
    async def delete_room(self, transport_room_id: str) -> None:
        return None


class TestDelete:
    async def test_deleting_a_room_is_recorded_with_the_deletion(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_user(session_factory, "owner")
        room_id = await _make_public_room(
            session_factory, owner_id=owner, member_agent_ids=[]
        )
        service = _room_service(session_factory)
        service._provisioning = _Provisioning()  # type: ignore[assignment]

        with log_context(user_id=owner):
            await service.delete_room(room_id, retire_channel=False)

        [deleted] = await _events(session_factory, AuditAction.ROOM_DELETED)
        assert deleted.target_id == room_id
        assert deleted.actor_user_id == owner
        assert deleted.details == {
            "name": "secret",
            "bridge_id": None,
            "acting_agent_id": None,
        }


class TestRegistration:
    async def test_a_new_agent_and_a_reregistration_are_recorded(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        owner = await _make_user(session_factory, "owner")
        svc = _service(session_factory)
        svc.api_key_cache = _Listeners()  # type: ignore[assignment]
        agent_id = await _register(svc, "newcomer", owner)
        await svc.register_agent(
            name="newcomer",
            description="again",
            connector_type="test",
            integration_profile=_PROFILE,
            owner_id=owner,
            overwrite=True,
            registration_path="token",
        )

        [registered] = await _events(session_factory, AuditAction.AGENT_REGISTERED)
        assert registered.target_type == "agent"
        assert registered.target_id == agent_id
        assert registered.actor_user_id == owner
        assert registered.details is not None
        assert registered.details["agent_name"] == "newcomer"
        assert registered.details["registration_path"] == "other"
        [again] = await _events(session_factory, AuditAction.AGENT_REREGISTERED)
        assert again.target_id == agent_id
        assert again.details is not None
        assert again.details["registration_path"] == "token"


async def _agent_id_client(session: AsyncSession, agent_id: str) -> str:
    agent = await session.get(Agent, agent_id)
    assert agent is not None
    return agent.client_id
