from __future__ import annotations

import asyncio

import pytest

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import ClientRoom
from switch_core.sessions.service import SessionError
from tests.switch_core.sessions.test_authority import setup


def event():
    return AgentEvent(
        type="message",
        room_id="room-demo",
        bridge_id="bridge",
        payload=MessagePayload(
            addressed=True,
            sender="@owner:example.test",
            sender_name="Owner",
            message_id="message",
            body="Run the check",
            timestamp=1,
        ),
    )


@pytest.mark.asyncio
async def test_room_admission_uses_verified_content_and_survives_lost_ack(
    session_factory,
):
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue("agent-demo", "room-demo", event())
    args = (
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
    )
    receipt = await service.submit_room_message(*args, buffer)
    assert receipt.status == "accepted"
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert len(pending) == 1
    assert pending[0].origin.actor_id == "@owner:example.test"
    assert pending[0].origin.surface == "slack"
    assert pending[0].body.text.endswith("Run the check")
    assert (
        await service.submit_room_message(*args, EventBuffer())
    ).command_id == receipt.command_id
    with pytest.raises(SessionError, match="verified addressed"):
        await service.submit_room_message(*args[:5], "forged", sequence, buffer)
    with pytest.raises(SessionError, match="does not own"):
        await service.submit_room_message(
            "agent-demo", "session-demo", "other", *args[3:], buffer
        )
    async with session_factory() as db, db.begin():
        await db.delete(await db.get(ClientRoom, ("agent-client", "room-demo")))
    with pytest.raises(SessionError, match="not a member"):
        await service.submit_room_message(*args, buffer)


@pytest.mark.asyncio
async def test_two_sessions_cannot_execute_the_same_room_delivery(session_factory):
    service, epoch = await setup(session_factory)
    current = await service.snapshot("session-demo", "owner")
    other = await service.acquire(
        "agent-demo", current.session.model_copy(update={"session_id": "other-session"})
    )
    buffer = EventBuffer()
    sequence = buffer.enqueue("agent-demo", "room-demo", event())
    results = await asyncio.gather(
        *(
            service.submit_room_message(
                "agent-demo",
                session_id,
                "host-demo",
                generation,
                "room-demo",
                "message",
                sequence,
                buffer,
            )
            for session_id, generation in (
                ("session-demo", epoch),
                ("other-session", other.session.epoch),
            )
        ),
        return_exceptions=True,
    )
    assert len([result for result in results if not isinstance(result, Exception)]) == 1
    error = next(result for result in results if isinstance(result, SessionError))
    assert error.code == "ROOM_MESSAGE_RESERVED"
