"""Chat cancellation resolves room-scoped queued turns and their actual sender."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import select

from switch_core.bridges.agent import commands
from switch_core.db.models import AgentSessionActivityItem, Message, Room
from switch_core.events import CommandEvent
from tests.switch_core.bridges.agent.test_retry_command_checks import _member
from tests.switch_core.gateway.agent_route_harness import add_agent

TURN = "12345678-aaaa-4444-8888-111111111111"
COLLISION = "12345678-bbbb-4444-8888-222222222222"


@pytest.fixture
async def cancellation(session_factory):
    async with session_factory() as db:
        owner, owner_client = await _member(db, "owner")
        _, sender = await _member(db, "sender")
        _, stranger = await _member(db, "stranger")
        agent = await add_agent(db, name="helper", owner_id=owner.id)
        other_agent = await add_agent(db, name="other", owner_id=owner.id)
        room = Room(
            transport_room_id="!here:test",
            name="here",
            description="",
            owner_id=owner.id,
        )
        other_room = Room(
            transport_room_id="!there:test",
            name="there",
            description="",
            owner_id=owner.id,
        )
        db.add_all([room, other_room])
        await db.flush()
        db.add(
            Message(
                room_id=room.id,
                seq=1,
                transport_event_id="$original",
                sender_id=sender.transport_user_id,
                sender_client_id=sender.id,
                event_type="m.room.message",
                body="@helper original",
                content={"body": "@helper original"},
            )
        )
        db.add(
            Message(
                room_id=room.id,
                seq=2,
                transport_event_id="$other",
                sender_id=owner_client.transport_user_id,
                sender_client_id=owner_client.id,
                event_type="m.room.message",
                body="@helper other",
                content={"body": "@helper other"},
            )
        )
        await db.commit()

    async def add(
        turn_id=TURN,
        *,
        status="queued",
        where=room,
        who=agent,
        session_id="session-original",
        message_id="$original",
    ):
        async with session_factory() as db:
            db.add(
                AgentSessionActivityItem(
                    agent_id=who.id,
                    session_id=session_id,
                    turn_id=turn_id,
                    item_id="turn",
                    kind="turn",
                    revision=1,
                    status=status,
                    title="Turn",
                    text="",
                    room_id=where.id,
                    message_id=message_id,
                    occurred_at=datetime.now(UTC),
                )
            )
            await db.commit()

    client = SimpleNamespace(session_factory=session_factory)

    async def resolve(target=TURN, asker=sender, where=room, who=agent):
        event = CommandEvent(
            command="cancel",
            args=f"@helper {target}",
            user_id=asker.transport_user_id,
            user_name=asker.display_name,
            message_id="$cancel",
            thread_id=None,
        )
        return await commands._cancel_target(client, where.id, event, who, target)

    return SimpleNamespace(
        add=add,
        resolve=resolve,
        client=client,
        agent=agent,
        other_agent=other_agent,
        room=room,
        other_room=other_room,
        sender=sender,
        owner=owner_client,
        stranger=stranger,
    )


@pytest.mark.parametrize("target", [TURN, TURN[:8]])
async def test_full_id_and_short_prefix_resolve_without_changing_history(
    cancellation, session_factory, target
):
    c = cancellation
    await c.add()
    row = await c.resolve(target)
    assert isinstance(row, AgentSessionActivityItem)
    assert (row.turn_id, row.session_id, row.status) == (
        TURN,
        "session-original",
        "queued",
    )
    async with session_factory() as db:
        original = (
            await db.execute(
                select(Message).where(
                    Message.room_id == c.room.id,
                    Message.transport_event_id == "$original",
                )
            )
        ).scalar_one()
        assert original.body == "@helper original"


async def test_prefix_collision_requires_full_id_even_when_one_is_another_senders(
    cancellation,
):
    c = cancellation
    await c.add()
    await c.add(COLLISION, message_id="$other")
    assert "multiple queued turns" in await c.resolve(TURN[:8])
    assert (await c.resolve(TURN)).turn_id == TURN


async def test_prefix_ignores_other_agents_rooms_and_nonqueued_turns(cancellation):
    c = cancellation
    await c.add()
    await c.add(COLLISION, who=c.other_agent)
    await c.add(COLLISION, where=c.other_room, session_id="session-other-room")
    await c.add(COLLISION, status="running")
    assert (await c.resolve(TURN[:8])).turn_id == TURN
    assert "no queued turn matches" in await c.resolve("does-not-exist")
    assert "no queued turn matches" in await c.resolve("%")
    assert "no queued turn matches" in await c.resolve("_")


@pytest.mark.parametrize("asker", ["stranger", "owner"])
async def test_only_original_sender_not_even_room_owner_may_cancel(cancellation, asker):
    c = cancellation
    await c.add()
    assert "only the original sender" in await c.resolve(asker=getattr(c, asker))


@pytest.mark.parametrize("status", ["running", "completed", "interrupted", "error"])
async def test_started_or_ended_full_id_is_refused_with_interrupt_pointer(
    cancellation, status
):
    c = cancellation
    await c.add(status=status)
    assert "!interrupt" in await c.resolve()
    assert "no queued turn matches" in await c.resolve(TURN[:8])


async def test_cancelled_turn_is_terminal_and_missing_original_fails_closed(
    cancellation,
):
    c = cancellation
    await c.add(status="cancelled")
    await c.add(COLLISION, message_id="$missing")
    assert "already cancelled" in await c.resolve()
    assert "only the original sender" in await c.resolve(COLLISION)


async def test_relay_names_the_exact_session_and_only_acknowledges_request(
    cancellation, monkeypatch
):
    c = cancellation
    await c.add()
    c.client._fresh_agent = AsyncMock(return_value=c.agent)
    c.client._resolve_room_meta = AsyncMock(
        return_value=SimpleNamespace(room_id=c.room.id)
    )
    relay = Mock(return_value=True)
    c.client._connections = SimpleNamespace(relay_session_command=relay)
    reply = AsyncMock()
    monkeypatch.setattr(commands, "_reply", reply)
    monkeypatch.setattr(commands, "_room_surface", AsyncMock(return_value="mattermost"))
    event = CommandEvent(
        command="cancel",
        args=f"@helper {TURN[:8]}",
        user_id=c.sender.transport_user_id,
        user_name="sender",
        message_id="$cancel",
        thread_id="$thread",
    )
    decision = await commands._decide_cancel(
        c.client, SimpleNamespace(room_id=c.room.transport_room_id), event
    )
    assert decision.queued is None
    relay.assert_not_called()
    await decision.answer()
    frame = relay.call_args.args[1]
    assert frame["body"] == {"type": "turn.cancel", "turnId": TURN}
    assert frame["sessionId"] == "session-original"
    assert frame["origin"]["actorId"] == c.sender.transport_user_id
    assert frame["origin"]["roomId"] == c.room.id
    assert "Cancellation requested" in reply.call_args.args[3]
    again = await commands._decide_cancel(
        c.client, SimpleNamespace(room_id=c.room.transport_room_id), event
    )
    await again.answer()
    assert relay.call_args.args[1]["commandId"] == frame["commandId"]
    relay.return_value = False
    await decision.answer()
    assert "not connected" in reply.call_args.args[3]


@pytest.mark.parametrize("args", ["", "@helper", "@helper id extra", "id"])
async def test_malformed_commands_do_not_relay(args, monkeypatch):
    reply = AsyncMock()
    monkeypatch.setattr(commands, "_reply", reply)
    decision = await commands._decide_cancel(
        SimpleNamespace(),
        SimpleNamespace(),
        CommandEvent(
            command="cancel",
            args=args,
            user_id="@sender:test",
            user_name="sender",
            message_id="$cancel",
            thread_id=None,
        ),
    )
    await decision.answer()
    assert "Usage: !cancel @agent <turn-id>" in reply.call_args.args[3]
