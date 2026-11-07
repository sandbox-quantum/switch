"""Cancellation names one sender's queued turn; only its host commits the outcome."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent import commands
from switch_core.bridges.collaboration.session.renderers import turn_state
from switch_core.db.models import AgentSessionActivityItem, Message, Room
from switch_core.events import CommandEvent
from switch_core.sessions.contract import (
    TURN_ENDED,
    TurnUpsert,
    parse_command,
    parse_host_event,
)
from tests.switch_core.bridges.agent.test_control_commands import _client, _Reply
from tests.switch_core.bridges.agent.test_retry_command_checks import _member
from tests.switch_core.gateway.agent_route_harness import add_agent


def test_cancel_contract_and_terminal_rendering() -> None:
    command = parse_command(
        {
            "contractVersion": 1,
            "commandId": "cancel-command",
            "sessionId": "original-session",
            "epoch": "generation",
            "origin": {
                "surface": "discord",
                "actorId": "@sender:test",
                "roomId": "original-room",
                "threadId": None,
                "messageId": "$cancel",
            },
            "body": {"type": "turn.cancel", "turnId": "12345678-target"},
        }
    )
    assert command.body.type == "turn.cancel"
    event = parse_host_event(
        {
            "contractVersion": 1,
            "eventId": "cancel-result",
            "sessionId": "original-session",
            "epoch": "generation",
            "hostSequence": 1,
            "occurredAt": "2026-01-01T00:00:00Z",
            "body": {
                "type": "turn.upsert",
                "turnId": "12345678-target",
                "status": "cancelled",
                "commandId": None,
            },
        }
    )
    assert event.body.type == "turn.upsert"
    assert event.body.status in TURN_ENDED
    assert (
        turn_state([], event.body, tool_detail=True)
        == "Turn cancelled before it started."
    )


def test_queued_copy_exposes_cancel_command_and_short_turn_id() -> None:
    turn = TurnUpsert(
        type="turn.upsert", turn_id="12345678-target", status="queued", command_id=None
    )
    state = turn_state([], turn, tool_detail=True)
    assert "!cancel @agent-name 12345678" in state


async def test_cancel_selects_original_sender_agent_room_and_unique_turn(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner, _ = await _member(session, "owner")
        _, sender = await _member(session, "sender")
        _, stranger = await _member(session, "stranger")
        agent = await add_agent(session, name="helper", owner_id=owner.id)
        other_agent = await add_agent(session, name="other", owner_id=owner.id)
        room = Room(
            transport_room_id="!r:test", name="r", description="", owner_id=owner.id
        )
        other_room = Room(
            transport_room_id="!other:test",
            name="other",
            description="",
            owner_id=owner.id,
        )
        session.add_all([room, other_room])
        await session.flush()
        for index, (aid, rid, turn_id, status) in enumerate(
            [
                (agent.id, room.id, "12345678-target", "queued"),
                (other_agent.id, room.id, "12345678-foreign-agent", "queued"),
                (agent.id, other_room.id, "12345678-foreign-room", "queued"),
                (agent.id, room.id, "running-turn", "running"),
                (agent.id, room.id, "12345678-history", "completed"),
            ]
        ):
            message_id = f"$message-{index}"
            session.add(
                Message(
                    room_id=rid,
                    seq=index + 1,
                    transport_event_id=message_id,
                    sender_id=sender.transport_user_id,
                    sender_client_id=sender.id,
                    event_type="m.room.message",
                    body="@helper task",
                    content={"body": "@helper task"},
                )
            )
            session.add(
                AgentSessionActivityItem(
                    agent_id=aid,
                    session_id="recorded-session",
                    turn_id=turn_id,
                    item_id="turn",
                    kind="turn",
                    revision=1,
                    status=status,
                    title="Turn",
                    text="",
                    room_id=rid,
                    message_id=message_id,
                    occurred_at=datetime.now(UTC),
                )
            )
        await session.commit()
    client = SimpleNamespace(session_factory=session_factory)
    event = SimpleNamespace(user_id=sender.transport_user_id)
    row, refusal = await commands._cancel_target(
        client, room.id, event, agent, "12345678"
    )
    assert refusal is None and row is not None and row.turn_id == "12345678-target"
    assert row.session_id == "recorded-session"
    row, refusal = await commands._cancel_target(
        client,
        room.id,
        SimpleNamespace(user_id=stranger.transport_user_id),
        agent,
        "12345678",
    )
    assert row is None and "only whoever sent" in refusal.lower()
    row, refusal = await commands._cancel_target(
        client, room.id, event, agent, "running-turn"
    )
    assert row is None and "!interrupt" in refusal
    row, refusal = await commands._cancel_target(
        client, room.id, event, agent, "missing-turn"
    )
    assert row is None and "not found" in refusal.lower()
    async with session_factory() as session:
        original = await session.scalar(
            select(AgentSessionActivityItem).where(
                AgentSessionActivityItem.turn_id == "12345678-target"
            )
        )
        assert original is not None
        session.add(
            AgentSessionActivityItem(
                agent_id=agent.id,
                session_id="other-session",
                turn_id="12345678-second",
                item_id="turn",
                kind="turn",
                revision=1,
                status="queued",
                title="Turn",
                text="",
                room_id=room.id,
                message_id="$message-0",
                occurred_at=datetime.now(UTC),
            )
        )
        await session.commit()
    row, refusal = await commands._cancel_target(
        client, room.id, event, agent, "12345678"
    )
    assert row is None and "ambiguous" in refusal.lower()
    row, refusal = await commands._cancel_target(
        client, room.id, event, agent, "12345678-target"
    )
    assert refusal is None and row is not None
    async with session_factory() as session:
        assert (
            await session.scalar(
                select(Message).where(Message.transport_event_id == "$message-0")
            )
            is not None
        )
        original = await session.scalar(
            select(AgentSessionActivityItem).where(
                AgentSessionActivityItem.turn_id == "12345678-target"
            )
        )
        assert original is not None and original.status == "queued"


async def test_cancel_relays_recorded_session_not_current_placement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = _Reply()
    relayed: list[object] = []
    client = _client(
        reply,
        command_level="unsupported",
        enqueue=[],
        placed="new-placement",
        relayed=relayed,
    )

    async def target(*_args: object) -> tuple[SimpleNamespace, None]:
        return SimpleNamespace(
            session_id="original-session", turn_id="12345678-target"
        ), None

    async def surface(*_args: object) -> str:
        return "discord"

    monkeypatch.setattr(commands, "_cancel_target", target)
    monkeypatch.setattr(commands, "_room_surface", surface)
    monkeypatch.setattr(commands, "_reply", reply)
    event = CommandEvent(
        command="cancel",
        args="@cc 12345678",
        user_id="@sender:test",
        user_name="sender",
        message_id="$cancel",
        thread_id=None,
    )
    decision = await commands._decide_cancel(
        client, SimpleNamespace(room_id="!r:test"), event
    )
    assert decision.queued is None and decision.answer is not None
    await decision.answer()
    frame = relayed[0]
    assert frame["sessionId"] == "original-session"
    assert frame["body"] == {"type": "turn.cancel", "turnId": "12345678-target"}
    assert frame["origin"]["actorId"] == "@sender:test"
    assert "requested" in reply.bodies[-1].lower()
    assert "cancelled" not in reply.bodies[-1].lower()
