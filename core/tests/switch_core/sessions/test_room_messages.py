from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    AttachmentRef,
    MessagePayload,
    RoomJoinPayload,
)
from switch_core.db.models import ClientRoom, MediaBlob, Room
from switch_core.sessions.service import SessionError
from tests.switch_core.sessions.test_authority import host_event, setup


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


@pytest.mark.asyncio
async def test_internal_room_admission_preserves_thread_context(session_factory):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        room = await db.get(Room, "room-demo")
        room.bridge_id = None
    message = event().model_copy(update={"bridge_id": None})
    message.payload.thread_id = "thread-demo"
    buffer = EventBuffer()
    sequence = buffer.enqueue("agent-demo", "room-demo", message)
    result = await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        buffer,
    )
    assert result.status == "accepted"
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert pending[0].origin.surface == "switch-web"
    assert "thread_id thread-demo" in pending[0].body.text


@pytest.mark.asyncio
async def test_room_attachment_is_copied_durably_with_caption_and_missing_file_notice(
    session_factory,
):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            MediaBlob(
                uri="switch-media://fixture",
                content_type="text/plain",
                filename="example.txt",
                size=5,
                data=b"hello",
            )
        )
    snapshot = await service.snapshot("session-demo", "owner")
    session = snapshot.session.model_dump(by_alias=True)
    session["status"] = "ready"
    session["capabilities"]["attachmentMimeTypes"] = ["text/plain"]
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 1, {"type": "session.upsert", "session": session}),
    )
    message = event()
    message.payload.attachments = [
        AttachmentRef(
            filename="example.txt",
            mimetype="text/plain",
            size=5,
            mxc="switch-media://fixture",
            msgtype="m.file",
        ),
        AttachmentRef(
            filename="missing.txt",
            mimetype="text/plain",
            size=5,
            mxc="switch-media://missing",
            msgtype="m.file",
        ),
    ]
    buffer = EventBuffer()
    sequence = buffer.enqueue("agent-demo", "room-demo", message)
    await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        buffer,
    )
    command = (await service.pending("agent-demo", "session-demo", "host-demo", epoch))[
        0
    ]
    assert "Run the check" in command.body.text
    assert "missing.txt" in command.body.text and "not delivered" in command.body.text
    assert len(command.body.attachments) == 1
    attachment = command.body.attachments[0]
    blob = await service.attachment(
        "agent-demo", "session-demo", "host-demo", epoch, attachment.attachment_id
    )
    assert blob.data == b"hello"
    assert blob.sha256 == attachment.sha256
    assert blob.sdk_session_id == "session-demo"


@pytest.mark.asyncio
async def test_room_binding_is_authorized_and_control_delivery_is_durable(
    session_factory,
):
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    connection = connections.open(
        agent_id="agent-demo",
        connection_id="connection-demo",
        scope="single",
        delivery_filter="addressed",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
    )
    connections.claim_room(connection, "room-demo")
    assert await service.bind_connection(
        "agent-demo", "session-demo", "host-demo", epoch, connection.id, connections
    ) == ["room-demo"]
    snapshot = await service.snapshot("session-demo", "owner")
    assert snapshot.session.room_ids == ["room-demo"]
    ready = snapshot.session.model_copy(
        update={
            "status": "ready",
            "capabilities": snapshot.session.capabilities.model_copy(
                update={"reset": True}
            ),
        }
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            1,
            {"type": "session.upsert", "session": ready.model_dump(by_alias=True)},
        ),
    )

    with pytest.raises(SessionError, match="does not own"):
        await service.bind_connection(
            "agent-demo",
            "session-demo",
            "wrong-host",
            epoch,
            connection.id,
            connections,
        )
    with pytest.raises(SessionError, match="permission"):
        await service.submit_room_control(
            "agent-demo",
            "room-demo",
            "reset",
            "@outsider:example.test",
            "reset-message",
            connections,
        )
    receipt = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "reset-message",
        connections,
    )
    assert receipt.status == "accepted"
    assert (
        await service.submit_room_control(
            "agent-demo",
            "room-demo",
            "reset",
            "@owner:example.test",
            "reset-message",
            connections,
        )
        == receipt
    )
    assert (
        len(await service.pending("agent-demo", "session-demo", "host-demo", epoch))
        == 1
    )
    connections.release_room(connection, "room-demo")
    assert (
        await service.bind_connection(
            "agent-demo", "session-demo", "host-demo", epoch, connection.id, connections
        )
        == []
    )
    assert (await service.snapshot("session-demo", "owner")).session.room_ids == []
    assert (
        await service.submit_room_control(
            "agent-demo",
            "room-demo",
            "reset",
            "@owner:example.test",
            "next-message",
            connections,
        )
        is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("listening", [True, False])
async def test_room_join_requires_opt_in_and_deduplicates(session_factory, listening):
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    payload = RoomJoinPayload(
        member="@visitor:example.test",
        member_name="Visitor 🌍",
        timestamp=10,
        listening=listening,
    )
    canonical = json.dumps(
        payload.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    message_id = "room_join:" + hashlib.sha256(canonical.encode()).hexdigest()
    sequence = buffer.enqueue(
        "agent-demo",
        "room-demo",
        AgentEvent(
            type="room_join", room_id="room-demo", bridge_id="bridge", payload=payload
        ),
    )
    args = (
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        message_id,
        sequence,
        buffer,
    )
    if not listening:
        with pytest.raises(SessionError, match="subscribed"):
            await service.submit_room_message(*args)
        return
    receipt = await service.submit_room_message(*args)
    assert await service.submit_room_message(*args) == receipt
    assert (
        len(await service.pending("agent-demo", "session-demo", "host-demo", epoch))
        == 1
    )
