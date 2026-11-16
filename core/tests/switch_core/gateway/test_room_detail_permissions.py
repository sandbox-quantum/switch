"""A room's detail says what the caller may do with it (`can_write`,
`can_manage`), by the same rules the routes enforce, so the dashboard offers a
change only where the server would allow it. The route coroutine is called
directly against real Postgres, as in `test_room_participant_read`."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User, room_agents
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.room_role_store import RoomRoleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.gateway import rooms as rooms_module
from switch_core.gateway.schemas import RoomUpdateRequest
from tests.switch_core.gateway.agent_route_harness import add_agent

_ROOM_STORE = RoomStore()
_NO_DECISIONS = DecisionAvailability(
    enabled=False,
    server=ServerDefault(endpoint_url=None, api_key=None, bedrock_enabled=False),
    store=DecisionSettingsStore(),
)


class _Protocol:
    """The parts of `AgentCore` a room's detail reads: no agent is live."""

    room_role_store = RoomRoleStore()
    agent_store = AgentStore()
    connections = SimpleNamespace(live_connection_ids=lambda: [])

    async def get_agent_statuses_by_ids_in_session(
        self, session: AsyncSession, room_id: str, agent_ids: list[str]
    ) -> dict[str, object]:
        return {}


class _RoomService:
    """Applies `update_room` on a session of its own, as `RoomService` does."""

    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = factory

    async def update_room(self, room_id: str, **changes: Any) -> None:
        async with self._factory() as session:
            room = await session.get(Room, room_id)
            assert room is not None
            for field, value in changes.items():
                if value is not None:
                    setattr(room, field, value)
            await session.commit()


async def _user(session: AsyncSession, name: str) -> User:
    user = User(name=name, email=f"{name}@example.com", role="user")
    session.add(user)
    await session.flush()
    return user


async def _room(
    session: AsyncSession,
    name: str,
    owner: User,
    write_visibility: str,
    read_visibility: str = "public",
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="",
        owner_id=owner.id,
        read_visibility=read_visibility,
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
        _NO_DECISIONS,
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

        # Public write no longer lets anyone change the room: that is its
        # owner's and admins' (`room_policy`).
        assert await _permissions(session, public, owner, False) == (True, True)
        assert await _permissions(session, public, admin, True) == (True, True)
        assert await _permissions(session, public, member, False) == (False, False)

        assert await _permissions(session, read_only, owner, False) == (True, True)
        assert await _permissions(session, read_only, admin, True) == (True, True)
        assert await _permissions(session, read_only, member, False) == (False, False)


async def test_taking_part_in_a_private_room_grants_reading_it_only(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        agent_owner = await _user(session, "agent-owner")
        private = await _room(
            session,
            "private",
            owner,
            write_visibility="private",
            read_visibility="private",
        )
        agent = await add_agent(session, name="their-agent", owner_id=agent_owner.id)
        await session.execute(
            room_agents.insert().values(room_id=private.id, agent_id=agent.id)
        )
        await session.commit()

        # They may read it (see `test_room_participant_read`), and that is all.
        flags = await _permissions(session, private, agent_owner, False)
        assert flags == (False, False)


async def test_a_change_answers_with_what_its_caller_may_do(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = await _user(session, "owner")
        public = await _room(session, "public", owner, write_visibility="public")
        await session.commit()

        detail = await rooms_module.patch_room(
            public.id,
            RoomUpdateRequest(name="renamed"),
            session,
            _RoomService(session_factory),  # type: ignore[arg-type]
            _ROOM_STORE,
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            _Protocol(),  # type: ignore[arg-type]
            _NO_DECISIONS,
            owner,
            False,
        )

    assert detail.name == "renamed"
    assert (detail.can_write, detail.can_manage) == (True, True)
