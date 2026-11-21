"""A typed `!cancel @agent <turn id>` names one of the agent's queued turns in
the room it is typed in, by the whole id or the first characters of it, and
only whoever sent the message that queued the turn may cancel it."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    Agent,
    AgentSessionActivityItem,
    Client,
    Message,
    Room,
    User,
)
from tests.switch_core.gateway.agent_route_harness import add_agent

TENANT = "00000000-0000-0000-0000-000000000000"

TURN_A = "1a2b3c4d-0000-4000-8000-000000000001"
TURN_B = "1a2b3c4d-0000-4000-8000-000000000002"
TURN_C = "9f8e7d6c-0000-4000-8000-000000000003"
RUNNING = "5e5e5e5e-0000-4000-8000-000000000004"
OTHER_ROOM = "7c7c7c7c-0000-4000-8000-000000000005"


async def _member(session: AsyncSession, name: str) -> Client:
    user = User(name=name, email=f"{name}@example.invalid", role="user")
    session.add(user)
    await session.flush()
    client = Client(
        transport_user_id=f"@member-{name}:test",
        display_name=name,
        type=MEMBER_CLIENT_TYPE,
        user_id=user.id,
    )
    session.add(client)
    await session.flush()
    return client


def _turn(
    agent: Agent, turn_id: str, room: Room, message_id: str, status: str
) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        agent_id=agent.id,
        session_id="s1",
        turn_id=turn_id,
        item_id="turn",
        kind="turn",
        revision=1,
        status=status,
        title="Turn",
        text="",
        room_id=room.id,
        message_id=message_id,
        occurred_at=datetime.now(UTC),
    )


def _message(room: Room, seq: int, sender: Client) -> Message:
    return Message(
        room_id=room.id,
        seq=seq,
        transport_event_id=f"$m{seq}",
        sender_id=sender.transport_user_id,
        sender_client_id=sender.id,
        event_type="m.room.message",
        body="@helper plan",
        content={"body": "@helper plan"},
    )


async def test_a_typed_cancel_resolves_only_the_askers_queued_turn(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        sender = await _member(session, "sender")
        stranger = await _member(session, "stranger")
        user = await session.get(User, sender.user_id)
        assert user is not None
        agent = await add_agent(session, name="helper", owner_id=user.id)
        elsewhere = await add_agent(session, name="elsewhere", owner_id=user.id)
        room = Room(
            transport_room_id="!r:test", name="r", description="", owner_id=user.id
        )
        other = Room(
            transport_room_id="!o:test", name="o", description="", owner_id=user.id
        )
        session.add_all([room, other])
        await session.flush()
        session.add_all(
            [
                _message(room, 1, sender),
                _message(room, 2, sender),
                _message(room, 3, sender),
                _message(room, 4, sender),
                _turn(agent, RUNNING, room, "$m1", "running"),
                _turn(agent, TURN_A, room, "$m2", "queued"),
                _turn(agent, TURN_B, room, "$m3", "queued"),
                _turn(agent, TURN_C, room, "$m4", "queued"),
                _turn(agent, OTHER_ROOM, other, "$m9", "queued"),
                _turn(
                    elsewhere,
                    "1a2b3c4d-0000-4000-8000-0000000000ff",
                    room,
                    "$m2",
                    "queued",
                ),
            ]
        )
        await session.commit()

    client = SimpleNamespace(session_factory=session_factory, tenant_id=TENANT)

    async def resolve(
        args: str, asker: Client = sender
    ) -> tuple[str | None, str | None]:
        event = SimpleNamespace(user_id=asker.transport_user_id, args=args)
        return await commands._cancel_target(client, room.id, event, agent)  # type: ignore[arg-type]

    # The first eight characters, any case, or the whole id.
    assert await resolve("@helper 9f8e7d6c") == (TURN_C, None)
    assert await resolve("@helper 9F8E7D6C") == (TURN_C, None)
    assert await resolve(f"@helper {TURN_C}") == (TURN_C, None)

    # More than one queued turn starts the same way: refused, saying so.
    turn, refusal = await resolve("@helper 1a2b3c4d")
    assert turn is None
    assert refusal is not None and "matches 2" in refusal
    assert await resolve(f"@helper {TURN_A}") == (TURN_A, None)

    # None: refused, saying so. Another room's turn is not this room's.
    turn, refusal = await resolve("@helper deadbeef")
    assert turn is None
    assert refusal is not None and "no queued turn" in refusal
    turn, refusal = await resolve("@helper 7c7c7c7c")
    assert turn is None
    assert refusal is not None and "no queued turn" in refusal

    # A turn already running has started: use !interrupt.
    turn, refusal = await resolve("@helper 5e5e5e5e")
    assert turn is None
    assert refusal is not None
    assert "already started" in refusal and "!interrupt @helper" in refusal

    # No turn named at all.
    turn, refusal = await resolve("@helper")
    assert turn is None
    assert refusal is not None and "names no turn" in refusal

    # Only whoever sent the message that queued the turn.
    turn, refusal = await resolve("@helper 9f8e7d6c", stranger)
    assert turn is None
    assert refusal is not None and "only whoever sent that message" in refusal


async def test_a_turn_whose_sender_cannot_be_established_is_not_cancelled(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        sender = await _member(session, "sender")
        user = await session.get(User, sender.user_id)
        assert user is not None
        agent = await add_agent(session, name="helper", owner_id=user.id)
        room = Room(
            transport_room_id="!r:test", name="r", description="", owner_id=user.id
        )
        session.add(room)
        await session.flush()
        session.add(_turn(agent, TURN_C, room, "$gone", "queued"))
        await session.commit()

    client = SimpleNamespace(session_factory=session_factory, tenant_id=TENANT)
    event = SimpleNamespace(user_id=sender.transport_user_id, args="@helper 9f8e7d6c")
    turn, refusal = await commands._cancel_target(client, room.id, event, agent)  # type: ignore[arg-type]
    assert turn is None
    assert refusal is not None and "only whoever sent that message" in refusal
