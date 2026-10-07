"""Changing a room's instructions from the gateway tells the room's agents.

The route coroutine is exercised directly against real Postgres, with a room
service that writes through the real store and a protocol that records the
announcement instead of reaching an event buffer.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import AgentConnectionRegistry
from switch_core.db.models import Room, User
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.rooms import patch_room
from switch_core.gateway.schemas import RoomUpdateRequest

_ROOM_STORE = RoomStore()


class _StoreRoomService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def update_room(self, room_id: str, **fields: Any) -> None:
        await _ROOM_STORE.update_fields(
            self._session,
            room_id,
            name=fields["name"],
            description=fields["description"],
            instructions=fields["instructions"],
            admin_mode=fields["admin_mode"],
        )


class _RecordingProtocol:
    def __init__(self) -> None:
        self.room_role_store = RoomRoleStore()
        self.connections = AgentConnectionRegistry()
        self.announced: list[tuple[str, str]] = []

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, Any]:
        return {}

    async def announce_room_instructions_changed(
        self, room_id: str, *, changed_by_name: str
    ) -> None:
        self.announced.append((room_id, changed_by_name))


async def _setup(session: AsyncSession) -> tuple[User, Room]:
    user = User(name="louisa", email="louisa@example.com", role="user")
    session.add(user)
    await session.flush()
    room = Room(
        transport_room_id="!r1:test",
        name="r1",
        description="r1 desc",
        owner_id=user.id,
        instructions="Be excellent",
    )
    session.add(room)
    await session.flush()
    return user, room


async def _patch(
    session: AsyncSession, room: Room, user: User, req: RoomUpdateRequest
) -> _RecordingProtocol:
    protocol = _RecordingProtocol()
    await patch_room(
        room.id,
        req,
        session,
        _StoreRoomService(session),  # type: ignore[arg-type]
        _ROOM_STORE,
        None,  # type: ignore[arg-type]  # bridge_store: the room has no bridge
        None,  # type: ignore[arg-type]  # external_user_store
        protocol,  # type: ignore[arg-type]
        user,
        False,
    )
    return protocol


class TestRoomInstructionsAnnounced:
    async def test_changed_instructions_are_announced(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user, room = await _setup(session)

            protocol = await _patch(
                session, room, user, RoomUpdateRequest(instructions="Be kind")
            )

            assert protocol.announced == [(room.id, "louisa")]

    async def test_unchanged_instructions_are_not_announced(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user, room = await _setup(session)

            protocol = await _patch(
                session, room, user, RoomUpdateRequest(instructions="Be excellent")
            )

            assert protocol.announced == []

    async def test_other_fields_are_not_announced(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user, room = await _setup(session)

            protocol = await _patch(
                session, room, user, RoomUpdateRequest(name="renamed")
            )

            assert protocol.announced == []
