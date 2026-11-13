"""A typed `!cancel @agent <id>` names one queued turn of that agent in this
room, by some or all of its id, and only the message's sender may cancel it."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import AgentSessionActivityItem, Client, Message, Room, User
from switch_core.sessions.presentation import CANCEL_ID_CHARS, cancel_command
from tests.switch_core.gateway.agent_route_harness import add_agent

TURN = "378893ee-5a16-5c9b-a6a0-b288ed58745b"
NEIGHBOUR = "378893ee-0000-4000-8000-000000000001"


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
    agent_id: str, room_id: str, turn_id: str, status: str, message_id: str
) -> AgentSessionActivityItem:
    return AgentSessionActivityItem(
        agent_id=agent_id,
        session_id="s1",
        turn_id=turn_id,
        item_id="turn",
        kind="turn",
        revision=1,
        status=status,
        title="",
        text="",
        room_id=room_id,
        message_id=message_id,
        occurred_at=datetime.now(UTC),
    )


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]) -> SimpleNamespace:
    """`helper` with one queued turn in a room, asked by `sender`, and a turn
    in another room whose id starts the same way."""
    async with session_factory() as session:
        sender = await _member(session, "sender")
        stranger = await _member(session, "stranger")
        owner = await _member(session, "owner")
        agent = await add_agent(session, name="helper", owner_id=owner.user_id)
        room = Room(transport_room_id="!r:test", name="r", description="")
        elsewhere = Room(transport_room_id="!e:test", name="e", description="")
        session.add_all([room, elsewhere])
        await session.flush()
        for seq, (where, event_id) in enumerate(
            [(room, "$asked"), (elsewhere, "$there")], start=1
        ):
            session.add(
                Message(
                    room_id=where.id,
                    seq=seq,
                    transport_event_id=event_id,
                    sender_id=sender.transport_user_id,
                    sender_client_id=sender.id,
                    event_type="m.room.message",
                    body="@helper plan",
                    content={"body": "@helper plan"},
                )
            )
        session.add(_turn(agent.id, room.id, TURN, "queued", "$asked"))
        session.add(_turn(agent.id, elsewhere.id, NEIGHBOUR, "queued", "$there"))
        await session.commit()
    return SimpleNamespace(
        client=SimpleNamespace(session_factory=session_factory),
        agent=agent,
        room=room,
        sender=sender,
        stranger=stranger,
        session_factory=session_factory,
    )


async def _resolve(
    scene: SimpleNamespace, prefix: str, asker: Client | None = None
) -> str:
    event = SimpleNamespace(user_id=(asker or scene.sender).transport_user_id)
    return await commands._queued_turn(  # type: ignore[arg-type]
        scene.client, scene.room.id, event, scene.agent, prefix
    )


async def _status(scene: SimpleNamespace, turn_id: str, status: str) -> None:
    async with scene.session_factory() as session:
        row = await session.get(
            AgentSessionActivityItem,
            (
                "00000000-0000-0000-0000-000000000000",
                scene.agent.id,
                "s1",
                turn_id,
                "turn",
            ),
        )
        assert row is not None
        row.status = status
        await session.commit()


async def test_the_id_on_the_card_and_the_whole_id_both_name_the_turn(scene) -> None:
    shown = cancel_command("helper", TURN).split()[-1]
    assert shown == TURN[:CANCEL_ID_CHARS]
    assert await _resolve(scene, shown) == TURN
    assert await _resolve(scene, TURN) == TURN
    assert await _resolve(scene, TURN[:CANCEL_ID_CHARS].upper()) == TURN


async def test_a_prefix_never_reaches_another_rooms_turn(scene) -> None:
    """`NEIGHBOUR` starts the same way, but is queued in another room."""
    assert await _resolve(scene, "378893ee") == TURN
    with pytest.raises(commands.CancelRefused, match="no message waiting"):
        await _resolve(scene, NEIGHBOUR)


async def test_a_prefix_that_matches_several_queued_turns_is_refused(scene) -> None:
    async with scene.session_factory() as session:
        session.add(
            _turn(
                scene.agent.id,
                scene.room.id,
                "378893ee-1111-4000-8000-000000000002",
                "queued",
                "$asked",
            )
        )
        await session.commit()
    with pytest.raises(commands.CancelRefused, match="starts 2 messages") as refused:
        await _resolve(scene, "378893ee")
    assert TURN in str(refused.value)
    assert await _resolve(scene, TURN) == TURN


async def test_only_whoever_sent_the_message_may_cancel_it(scene) -> None:
    with pytest.raises(commands.CancelRefused, match="Only whoever sent"):
        await _resolve(scene, TURN, asker=scene.stranger)


async def test_a_started_turn_points_at_interrupt(scene) -> None:
    await _status(scene, TURN, "running")
    with pytest.raises(commands.CancelRefused, match=r"!interrupt @helper"):
        await _resolve(scene, "378893ee")


async def test_an_ended_turn_is_not_waiting(scene) -> None:
    await _status(scene, TURN, "cancelled")
    with pytest.raises(commands.CancelRefused, match="isn't waiting"):
        await _resolve(scene, "378893ee")


async def test_what_is_not_an_id_is_refused_before_any_lookup(scene) -> None:
    for typed in ("50%", "abc_def", "x" * 65):
        with pytest.raises(commands.CancelRefused, match="is not a message id"):
            await _resolve(scene, typed)


def test_a_cancel_is_relayed_as_the_contracts_turn_cancel() -> None:
    frame = commands.room_control_frame(
        agent_id="agent",
        session_id="session",
        room_id="room",
        action="cancel",
        actor_id="@sender:test",
        message_id="$cancel",
        thread_id=None,
        surface="slack",
        requester_name="Sender",
        direct=False,
        target=TURN,
    )
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    with pytest.raises(ValueError, match="names the turn"):
        commands.room_control_frame(
            agent_id="agent",
            session_id="session",
            room_id="room",
            action="cancel",
            actor_id="@sender:test",
            message_id="$cancel",
            thread_id=None,
            surface="slack",
            requester_name="Sender",
            direct=False,
            target=None,
        )
