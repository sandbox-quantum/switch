"""A room's detail says what the caller may do with it (`can_write`,
`can_manage`), by the same rules the routes enforce, so the dashboard offers a
change only where the server would allow it. The route coroutine is called
directly against real Postgres, as in `test_room_participant_read`."""

from __future__ import annotations

from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import rooms as rooms_module

_ROOM_STORE = RoomStore()


class _Protocol:
    """The parts of `AgentCore` a room's detail reads: no agent is live."""

    room_role_store = RoomRoleStore()
    agent_store = AgentStore()
    connections = SimpleNamespace(live_connection_ids=lambda: [])

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, object]:
        return {}


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _room(
    session: AsyncSession, name: str, owner: User, write_visibility: str
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner.id,
        read_visibility="public",
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def _permissions(
    session: AsyncSession, room: Room, user: User, is_admin: bool
) -> tuple[bool, bool]:
    detail = await rooms_module.get_room(
        room.id,
        session,
        _ROOM_STORE,
        None,  # type: ignore[arg-type]
        None,  # type: ignore[arg-type]
        _Protocol(),  # type: ignore[arg-type]
        user,
        is_admin,
    )
    return detail.can_write, detail.can_manage


async def test_room_detail_reports_what_the_caller_may_do(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        admin = await _user(session, "admin")
        member = await _user(session, "member")
        public = await _room(session, "public", owner, write_visibility="public")
        read_only = await _room(session, "read-only", owner, write_visibility="private")
        await session.commit()

        # Public write lets anyone edit the room, but its access and deleting
        # it stay with the owner and admins.
        assert await _permissions(session, public, owner, False) == (True, True)
        assert await _permissions(session, public, admin, True) == (True, True)
        assert await _permissions(session, public, member, False) == (True, False)

        assert await _permissions(session, read_only, owner, False) == (True, True)
        assert await _permissions(session, read_only, admin, True) == (True, True)
        assert await _permissions(session, read_only, member, False) == (False, False)
