"""The db-buffer on the test database, and the agent rows its events point at.

Agent events are rows in Postgres now, so a test of anything that queues or
reads them runs against the real tables: offsets, tenant isolation, cascades
and retention are SQL, and a stand-in would test the stand-in.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select, update

from switch_core.bridges.agent.protocol.event_buffer import (
    EventBuffer,
    RoomAnnouncements,
)
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    ApiKey,
    Client,
    ClientRoom,
    Message,
    Room,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


class QuietRooms:
    """Room announcements for a test that has none to make.

    A stream that reads a room's conversation asks to be woken when the room
    has a new row. A test that writes conversation while a stream waits, and
    expects the stream to wake for it, gives the buffer a running
    `MessageListener` instead (`tests/routing.py`, `room_bells`).
    """

    def subscribe(
        self,
        room_id: str,
        waker: Callable[[str], Awaitable[None]],
        *,
        types: frozenset[str] | None = None,
    ) -> None:
        return None

    def unsubscribe(
        self, room_id: str, waker: Callable[[str], Awaitable[None]]
    ) -> None:
        return None


def db_buffer_on(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    sequence_base: int = 0,
    retention_seconds: float = 3600,
    rooms: RoomAnnouncements | None = None,
    session_slots: int | None = None,
) -> EventBuffer:
    """The db-buffer on a test's database."""
    return EventBuffer(
        session_factory,
        sequence_base=sequence_base,
        rooms=rooms if rooms is not None else QuietRooms(),
        retention_seconds=retention_seconds,
        session_slots=session_slots,
    )


async def seed_agent(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> str:
    """An agent row with this id, and the client, key and owner it needs.

    Idempotent, so a test can name the agents it uses without tracking which
    it has made.
    """
    async with tenant_session(session_factory, tenant_id) as session:
        if await session.scalar(select(Agent.id).where(Agent.id == agent_id)):
            return agent_id
        suffix = uuid.uuid4().hex[:12]
        user = User(name=f"owner-{suffix}", email=f"{suffix}@test.local", role="user")
        session.add(user)
        await session.flush()
        api_key = ApiKey(
            user_id=user.id,
            key_hash=f"hash-{suffix}",
            encrypted_key="enc",
            label=agent_id,
            type="agent",
        )
        client = Client(
            transport_user_id=f"@{suffix}:test.local",
            display_name=agent_id,
            type="agent",
        )
        session.add_all([api_key, client])
        await session.flush()
        session.add(
            Agent(
                id=agent_id,
                name=f"{agent_id}-{suffix}",
                description="",
                agent_type="always_on",
                connector_type="claude_code",
                integration_profile={"connection_model": "always_on"},
                client_id=client.id,
                api_key_id=api_key.id,
            )
        )
        await session.commit()
    return agent_id


async def age_events(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    seconds: float,
    tenant_id: str = TENANT_ZERO_ID,
) -> None:
    """Make every event queued so far for `agent_id` older by `seconds`, so a
    test can put some past the retention window without waiting for it."""
    async with tenant_session(session_factory, tenant_id) as session:
        await session.execute(
            update(AgentEventRow)
            .where(AgentEventRow.agent_id == agent_id)
            .values(created_at=AgentEventRow.created_at - timedelta(seconds=seconds))
        )
        await session.commit()


async def seed_room(
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
    bridge_id: str | None = None,
    channel_type: str | None = None,
) -> str:
    """A room row with this id. Idempotent, like `seed_agent`."""
    async with tenant_session(session_factory, tenant_id) as session:
        if await session.scalar(select(Room.id).where(Room.id == room_id)):
            return room_id
        session.add(
            Room(
                id=room_id,
                transport_room_id=f"!{room_id}-{uuid.uuid4().hex[:8]}:test",
                name=room_id,
                description="",
                bridge_id=bridge_id,
                channel_type=channel_type,
            )
        )
        await session.commit()
    return room_id


async def seed_member(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    room_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
    joined_at: datetime | None = None,
) -> None:
    """The agent and the room, and the agent in the room since `joined_at`
    (an hour ago by default, before anything a test says there)."""
    await seed_agent(session_factory, agent_id, tenant_id=tenant_id)
    await seed_room(session_factory, room_id, tenant_id=tenant_id)
    async with tenant_session(session_factory, tenant_id) as session:
        client_id = await session.scalar(
            select(Agent.client_id).where(Agent.id == agent_id)
        )
        if await session.scalar(
            select(ClientRoom.room_id).where(
                ClientRoom.client_id == client_id, ClientRoom.room_id == room_id
            )
        ):
            return
        session.add(
            ClientRoom(
                client_id=client_id,
                room_id=room_id,
                joined_at=joined_at or datetime.now(UTC) - timedelta(hours=1),
            )
        )
        await session.commit()


async def sender_of(
    session_factory: async_sessionmaker[AsyncSession],
    agent_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> str:
    """The id an agent's own messages are sent under."""
    async with tenant_session(session_factory, tenant_id) as session:
        sender = await session.scalar(
            select(Client.transport_user_id)
            .join(Agent, Agent.client_id == Client.id)
            .where(Agent.id == agent_id)
        )
    assert sender is not None, f"no agent {agent_id}; seed it first"
    return sender


async def say(
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str,
    body: str = "hello",
    *,
    sender: str = "@alice:test",
    sender_name: str | None = "Alice",
    event_id: str | None = None,
    tenant_id: str = TENANT_ZERO_ID,
    sent_at: datetime | None = None,
    event_type: str = "m.room.message",
    content: dict[str, Any] | None = None,
) -> Message:
    """Write one row to a room's log and return it (its `seq` is its place
    in the room). The room must exist.

    Written straight to the table, as a row from before the router or from a
    process on the release before it would be: decided for nobody. A test of
    what the router decides writes through it instead (`tests/routing.py`).
    Stamped a second ago by the database's clock, so it reads as written
    after any membership the test made a moment before."""
    async with tenant_session(session_factory, tenant_id) as session:
        if sent_at is None:
            sent_at = await session.scalar(select(func.now() - timedelta(seconds=1)))
        message = await MessageStore().create(
            session,
            Message(
                room_id=room_id,
                transport_event_id=event_id or f"${uuid.uuid4().hex}",
                sender_id=sender,
                sender_name=sender_name,
                event_type=event_type,
                msgtype="m.text" if event_type == "m.room.message" else None,
                body=body,
                formatted_body=None,
                content=content if content is not None else {"body": body},
                sent_at=sent_at,
            ),
            [],
        )
        await session.commit()
        await session.refresh(message)
    return message


async def forget_room(
    session_factory: async_sessionmaker[AsyncSession],
    buffer: EventBuffer,
    agent_id: str,
    room_id: str,
    *,
    tenant_id: str = TENANT_ZERO_ID,
) -> None:
    """What taking the agent out of the room does to its own events there,
    in a transaction of its own (`EventBuffer.forget_room`)."""
    async with tenant_session(session_factory, tenant_id) as session:
        await buffer.forget_room(session, agent_id=agent_id, room_id=room_id)
        await session.commit()
