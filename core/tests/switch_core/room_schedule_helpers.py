"""What the room-schedule tests share: a person, a room, agents in it, and a
scheduler whose admin client records what it would post."""

from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.actor import SystemActor
from switch_core.clients.admin_messages import OnBehalfOf
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    Room,
    RoomSchedule,
    User,
    room_agents,
)
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.room_schedules import RoomScheduler


async def add_user(session: AsyncSession, name: str, *, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
    session.add(user)
    await session.flush()
    return user


async def add_room(
    session: AsyncSession,
    name: str,
    *,
    owner_id: str | None,
    write_visibility: str = "private",
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
        owner_id=owner_id,
        read_visibility="private",
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def add_agent(session: AsyncSession, name: str, *, owner: User) -> Agent:
    api_key = ApiKey(
        user_id=owner.id,
        key_hash=f"hash-{name}",
        encrypted_key="enc",
        label=name,
        type="agent",
    )
    client = Client(transport_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add_all([api_key, client])
    await session.flush()
    agent = Agent(
        name=name,
        description=f"{name} desc",
        agent_type="always_on",
        connector_type="claude_code",
        integration_profile={"connection_model": "always_on"},
        client_id=client.id,
        api_key_id=api_key.id,
    )
    session.add(agent)
    await session.flush()
    return agent


async def put_in_room(session: AsyncSession, room: Room, agent: Agent) -> None:
    await session.execute(
        insert(room_agents).values(room_id=room.id, agent_id=agent.id)
    )
    await session.flush()


class FakeAdmin(SystemActor):
    """The tenant's admin client, recording what it posts."""

    def __init__(self, *, fail: bool = False) -> None:
        self.posted: list[dict[str, Any]] = []
        self.notices: list[str] = []
        self._fail = fail

    async def send_platform_message(
        self,
        room_id: str,
        body: str,
        *,
        thread_root_id: str | None = None,
        on_behalf_of: OnBehalfOf | None = None,
        reply_in_channel: bool = False,
    ) -> str | None:
        if self._fail:
            return None
        self.posted.append({"room": room_id, "body": body, "for": on_behalf_of})
        return "$event"

    async def send_admin(self, room_id: str, body: str, **_: Any) -> None:
        self.notices.append(body)


class FakeLifecycle:
    def __init__(self, admin: FakeAdmin | None) -> None:
        self._admin = admin

    def get_by_type(self, client_type: str, tenant_id: str) -> list[SystemActor]:
        assert client_type == "admin" and tenant_id == TENANT_ZERO_ID
        return [self._admin] if self._admin is not None else []


def make_scheduler(
    session_factory: async_sessionmaker[AsyncSession], admin: FakeAdmin | None
) -> RoomScheduler:
    return RoomScheduler(
        session_factory=session_factory,
        client_lifecycle=FakeLifecycle(admin),  # type: ignore[arg-type]
        schedule_store=RoomScheduleStore(),
        room_store=RoomStore(),
        user_store=UserStore(),
    )


async def reload_schedule(
    session_factory: async_sessionmaker[AsyncSession], schedule_id: str
) -> RoomSchedule:
    async with session_factory() as session:
        row = await session.scalar(
            select(RoomSchedule).where(RoomSchedule.id == schedule_id)
        )
        assert row is not None
        return row
