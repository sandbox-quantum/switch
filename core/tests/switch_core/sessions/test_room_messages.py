from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, insert, select

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
from switch_core.db.models import (
    Agent,
    ClientRoom,
    MediaBlob,
    Message,
    MessageAttachment,
    RoleLease,
    Room,
    RoomRole,
    SdkSessionCommand,
    room_agents,
)
from switch_core.db.stores.message_store import MessageStore
from switch_core.delivery.replay import replay_room_event
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
    buffer = EventBuffer(sequence_base=0)
    sequence = buffer.enqueue("agent-demo", "room-demo", event())
    args = (
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        0,
        None,
    )
    receipt = await service.submit_room_message(*args, buffer, live_agent_ids=set)
    assert receipt.status == "accepted"
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert len(pending) == 1
    assert pending[0].origin.actor_id == "@owner:example.test"
    assert pending[0].origin.surface == "slack"
    assert pending[0].body.text.endswith("Run the check")
    assert (
        await service.submit_room_message(
            *args, EventBuffer(sequence_base=0), live_agent_ids=set
        )
    ).command_id == receipt.command_id
    with pytest.raises(SessionError, match="verified addressed"):
        await service.submit_room_message(
            *args[:5], "forged", sequence, 0, None, buffer, live_agent_ids=set
        )
    with pytest.raises(SessionError, match="does not own"):
        await service.submit_room_message(
            "agent-demo", "session-demo", "other", *args[3:], buffer, live_agent_ids=set
        )
    async with session_factory() as db, db.begin():
        await db.delete(await db.get(ClientRoom, ("agent-client", "room-demo")))
    with pytest.raises(SessionError, match="not a member"):
        await service.submit_room_message(*args, buffer, live_agent_ids=set)


@pytest.mark.asyncio
async def test_prompt_reports_unread_chatter_and_an_unreplayable_gap(session_factory):
    service, epoch = await setup(session_factory)
    buffer = EventBuffer(sequence_base=0)

    async def deliver(message_id, missed_count, gap_reason):
        message = event()
        message.payload.message_id = message_id
        sequence = buffer.enqueue("agent-demo", "room-demo", message)
        await service.submit_room_message(
            "agent-demo",
            "session-demo",
            "host-demo",
            epoch,
            "room-demo",
            message_id,
            sequence,
            missed_count,
            gap_reason,
            buffer,
            live_agent_ids=set,
        )
        pending = await service.pending(
            "agent-demo", "session-demo", "host-demo", epoch
        )
        return pending[-1].body.text

    assert (await deliver("quiet", 0, None)).endswith("Run the check")
    assert (await deliver("one", 1, None)).endswith(
        "\n(1 unaddressed room message arrived since the previous message you were sent — call read_context to catch up.)"
    )
    assert (await deliver("many", 2, None)).endswith(
        "\n(2 unaddressed room messages arrived since the previous message you were sent — call read_context to catch up.)"
    )
    text = await deliver("gapped", 2, "events aged out of the buffer")
    assert "2 unaddressed room messages arrived" in text
    assert text.endswith(
        "\n⚠️ Some earlier room events were dropped and cannot be replayed (events aged out of the buffer) — call read_context before responding."
    )


@pytest.mark.asyncio
async def test_two_sessions_cannot_execute_the_same_room_delivery(session_factory):
    service, epoch = await setup(session_factory)
    current = await service.snapshot("session-demo", "owner")
    other = await service.acquire(
        "agent-demo", current.session.model_copy(update={"session_id": "other-session"})
    )
    buffer = EventBuffer(sequence_base=0)
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
                0,
                None,
                buffer,
                live_agent_ids=set,
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
    buffer = EventBuffer(sequence_base=0)
    sequence = buffer.enqueue("agent-demo", "room-demo", message)
    result = await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        0,
        None,
        buffer,
        live_agent_ids=set,
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
    buffer = EventBuffer(sequence_base=0)
    sequence = buffer.enqueue("agent-demo", "room-demo", message)
    await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "message",
        sequence,
        0,
        None,
        buffer,
        live_agent_ids=set,
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
@pytest.mark.parametrize("session_status", ["ready", "error"])
async def test_room_binding_is_authorized_and_control_delivery_is_durable(
    session_factory,
    session_status,
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
            "status": session_status,
            "capabilities": snapshot.session.capabilities.model_copy(
                update={"reset": True, "compact": True}
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
            "thread-root",
            connections,
        )
    receipt = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "reset-message",
        "thread-root",
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
            "thread-root",
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
    with pytest.raises(SessionError, match="command was not queued"):
        await service.submit_room_control(
            "agent-demo",
            "room-demo",
            "reset",
            "@owner:example.test",
            "next-message",
            "thread-root",
            connections,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("listening", [True, False])
async def test_room_join_requires_opt_in_and_deduplicates(session_factory, listening):
    service, epoch = await setup(session_factory)
    buffer = EventBuffer(sequence_base=0)
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
        0,
        None,
        buffer,
    )
    if not listening:
        with pytest.raises(SessionError, match="subscribed"):
            await service.submit_room_message(*args, live_agent_ids=set)
        return
    receipt = await service.submit_room_message(*args, live_agent_ids=set)
    assert await service.submit_room_message(*args, live_agent_ids=set) == receipt
    assert (
        len(await service.pending("agent-demo", "session-demo", "host-demo", epoch))
        == 1
    )


async def ready_control_session(session_factory):
    """A live, ready session bound to `room-demo` that accepts room controls."""
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
    await service.bind_connection(
        "agent-demo", "session-demo", "host-demo", epoch, connection.id, connections
    )
    snapshot = await service.snapshot("session-demo", "owner")
    ready = snapshot.session.model_copy(
        update={
            "status": "ready",
            "capabilities": snapshot.session.capabilities.model_copy(
                update={"reset": True, "compact": True}
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
    return service, epoch, connections


@pytest.mark.asyncio
async def test_controls_in_one_thread_are_distinct_commands(session_factory):
    service, epoch, connections = await ready_control_session(session_factory)

    first = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "message-one",
        "thread-root",
        connections,
    )
    second = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "message-two",
        "thread-root",
        connections,
    )
    assert first.status == "accepted"
    assert second.status == "accepted"
    assert first.command_id != second.command_id

    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert [command.command_id for command in pending] == [
        first.command_id,
        second.command_id,
    ]
    assert [command.body.type for command in pending] == [
        "session.reset",
        "session.reset",
    ]
    assert {command.origin.thread_id for command in pending} == {"thread-root"}
    assert [command.origin.message_id for command in pending] == [
        "message-one",
        "message-two",
    ]


@pytest.mark.asyncio
async def test_redelivered_control_returns_the_stored_status(session_factory):
    service, epoch, connections = await ready_control_session(session_factory)

    args = (
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "message-one",
        "thread-root",
        connections,
    )
    receipt = await service.submit_room_control(*args)
    assert await service.submit_room_control(*args) == receipt

    async with session_factory() as db:
        assert (
            await db.scalar(select(func.count()).select_from(SdkSessionCommand))
        ) == 1
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert [command.command_id for command in pending] == [receipt.command_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["reset", "compact"])
@pytest.mark.parametrize("outcome", ["applied", "rejected", "unknown"])
async def test_room_control_followup_requires_success_and_keeps_context(
    session_factory, action, outcome
):
    service, epoch, connections = await ready_control_session(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            RoomRole(
                id="role-demo",
                room_id="room-demo",
                name="reviewer",
                instructions="Review changes.",
            )
        )
        await db.flush()
        db.add(
            RoleLease(role_id="role-demo", room_id="room-demo", agent_id="agent-demo")
        )
    receipt = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        action,
        "@owner:example.test",
        "control-message",
        "thread-root",
        connections,
    )
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert [c.body.type for c in pending] == [f"session.{action}"]
    async with session_factory() as db, db.begin():
        lease = await db.scalar(select(RoleLease))
        await db.delete(lease)
    result = host_event(
        epoch,
        2,
        {
            "type": "command.result",
            "commandId": receipt.command_id,
            "status": outcome,
            "code": None,
            "message": None,
        },
    )
    await service.ingest("agent-demo", "host-demo", result)
    await service.ingest("agent-demo", "host-demo", result)
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    if outcome != "applied":
        assert pending == []
        return
    assert len(pending) == 1
    followup = pending[0]
    assert followup.body.type == "message.send"
    assert 'previous role "reviewer"' in followup.body.text
    assert 'to "Owner" in thread "thread-root"' in followup.body.text
    assert 'room "room-demo"' in followup.body.text
    assert followup.origin.room_id == "room-demo"
    assert followup.origin.thread_id == "thread-root"
    assert followup.command_id != receipt.command_id
    assert (
        await service.pending("agent-demo", "session-demo", "host-demo", epoch)
        == pending
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            3,
            {
                "type": "command.result",
                "commandId": followup.command_id,
                "status": "unknown",
                "code": "OUTCOME_UNKNOWN",
                "message": "Execution interrupted.",
            },
        ),
    )
    assert await service.pending("agent-demo", "session-demo", "host-demo", epoch) == []
    async with session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(SdkSessionCommand)) == 2


@pytest.mark.asyncio
async def test_control_followup_waits_for_recovery_and_uses_fresh_epoch(
    session_factory,
):
    service, epoch, connections = await ready_control_session(session_factory)
    receipt = await service.submit_room_control(
        "agent-demo",
        "room-demo",
        "reset",
        "@owner:example.test",
        "control-message",
        "thread-root",
        connections,
    )
    await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            2,
            {
                "type": "command.result",
                "commandId": receipt.command_id,
                "status": "applied",
                "code": None,
                "message": None,
            },
        ),
        reconcile=True,
    )
    async with session_factory() as db:
        assert await db.scalar(select(func.count()).select_from(SdkSessionCommand)) == 1
    recovered = await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "recover-operation", 2
    )
    fresh = recovered.session.epoch
    assert fresh != epoch
    assert await service.pending("agent-demo", "session-demo", "host-demo", fresh) == []
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            fresh,
            1,
            {
                "type": "session.upsert",
                "session": recovered.session.model_copy(
                    update={"status": "ready"}
                ).model_dump(by_alias=True),
            },
        ).model_copy(update={"event_id": "recovered-ready"}),
    )
    pending = await service.pending("agent-demo", "session-demo", "host-demo", fresh)
    assert len(pending) == 1
    assert pending[0].epoch == fresh
    assert pending[0].body.type == "message.send"
    assert "previous role" not in pending[0].body.text
    assert (
        await service.command_status("session-demo", receipt.command_id, "owner")
    ).status == "applied"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    [
        "valid",
        "old",
        "self",
        "unaddressed",
        "denied",
        "historical",
        "group",
        "other_room",
        "future",
        "before_join",
        "archived",
    ],
)
async def test_room_replay_checks_durable_message_authority(session_factory, case):
    service, epoch = await setup(session_factory)
    body = "@agent-demo Run the check" if case != "unaddressed" else "Hello everyone"
    sender = {"self": "@agent:example.test", "denied": "@outsider:example.test"}.get(
        case, "@owner:example.test"
    )
    content = {"body": body, "msgtype": "m.text"}
    if case == "group":
        content["com.switch.attachment_group"] = {"id": "group", "index": 0, "total": 2}
    async with session_factory() as db, db.begin():
        membership = await db.get(ClientRoom, ("agent-client", "room-demo"))
        if case != "before_join":
            membership.joined_at = datetime.now(UTC) - timedelta(days=1)
        if case == "archived":
            room = await db.get(Room, "room-demo")
            room.archived_at = datetime.now(UTC)
        room_id = "room-demo"
        if case == "other_room":
            room_id = "other-room"
            db.add(
                Room(
                    id=room_id,
                    matrix_room_id="!other:example.test",
                    name="Other",
                    description="",
                )
            )
            await db.flush()
        row = Message(
            room_id=room_id,
            transport_event_id="saved-message",
            sender_id=sender,
            sender_name="Owner",
            event_type="m.room.message",
            msgtype="m.text",
            body=body,
            content=content,
            sent_at=datetime.now(UTC)
            - timedelta(minutes=20 if case == "old" else -1 if case == "future" else 1),
        )
        store = MessageStore()
        await (store.create_historical if case == "historical" else store.create)(
            db, row, []
        )
    args = (
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "saved-message",
        1,
        0,
        None,
        EventBuffer(sequence_base=1 << 32),
    )
    if case == "valid":
        receipt = await service.submit_room_message(*args, live_agent_ids=set)
        assert receipt.status == "accepted"
        pending = await service.pending(
            "agent-demo", "session-demo", "host-demo", epoch
        )
        assert pending[0].body.text.endswith(body)
        assert pending[0].origin.actor_id == sender
        assert (
            await service.submit_room_message(*args, live_agent_ids=set)
        ).command_id == receipt.command_id
    else:
        reasons = {
            "old": "retention window",
            "self": "own message",
            "unaddressed": "does not address",
            "denied": "not permitted",
            "historical": "Historical",
            "group": "multi-file",
            "other_room": "another room",
            "future": "future timestamp",
            "before_join": "predates",
            "archived": "archived",
        }
        with pytest.raises(SessionError, match=reasons[case]):
            await service.submit_room_message(*args, live_agent_ids=set)


@pytest.mark.asyncio
@pytest.mark.parametrize("media", [False, True])
async def test_replay_preserves_platform_sender_thread_and_sparse_media(
    session_factory, media
):
    service, _ = await setup(session_factory)
    async with session_factory() as db, db.begin():
        now = await service._now(db)
        membership = await db.get(ClientRoom, ("agent-client", "room-demo"))
        membership.joined_at = now - timedelta(minutes=1)
        room = await db.get(Room, "room-demo")
        room.bridge_id = None
        row = Message(
            room_id=room.id,
            transport_event_id="platform-message",
            sender_id="@owner:example.test",
            sender_name="Platform",
            event_type="m.room.message",
            msgtype="m.file" if media else "m.text",
            body="@agent-demo Inspect this",
            content={
                "com.switch.platform": {
                    "on_behalf_of": {"user_id": "owner", "name": "Owner"},
                    "reply_in_channel": True,
                }
            },
            sent_at=now,
            thread_root_event_id="thread",
        )
        files = (
            [
                MessageAttachment(
                    uri="switch-media://fixture",
                    filename=None,
                    mimetype=None,
                    size=None,
                )
            ]
            if media
            else []
        )
        await MessageStore().create(db, row, files)
        result = await replay_room_event(
            db,
            await db.get(Agent, "agent-demo"),
            room,
            row.transport_event_id,
            1,
            now,
            set,
        )
        payload = result.event.payload
        assert result.event.bridge_id is None
        assert payload.sender_kind == "platform"
        assert payload.on_behalf_of == "Owner"
        assert payload.sender_name == "Owner"
        assert payload.thread_id == ("thread" if media else None)
        if media:
            assert payload.attachments[0].filename == row.body
            assert payload.attachments[0].mimetype == ""
            assert payload.attachments[0].size == 0


@pytest.mark.asyncio
async def test_replay_addresses_a_live_push_role_without_a_fresh_lease(session_factory):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        now = await service._now(db)
        membership = await db.get(ClientRoom, ("agent-client", "room-demo"))
        membership.joined_at = now - timedelta(minutes=1)
        role = RoomRole(
            id="review-role",
            room_id="room-demo",
            name="reviewer",
            instructions="Review changes",
        )
        db.add(role)
        await db.flush()
        db.add(
            RoleLease(
                role_id=role.id,
                room_id="room-demo",
                agent_id="agent-demo",
                transport_session_id="push",
                last_seen_at=now - timedelta(days=1),
            )
        )
        await MessageStore().create(
            db,
            Message(
                room_id="room-demo",
                transport_event_id="role-message",
                sender_id="@owner:example.test",
                sender_name="Owner",
                event_type="m.room.message",
                msgtype="m.text",
                body="@reviewer Please review",
                content={},
                sent_at=now,
            ),
            [],
        )
    receipt = await service.submit_room_message(
        "agent-demo",
        "session-demo",
        "host-demo",
        epoch,
        "room-demo",
        "role-message",
        1,
        0,
        None,
        EventBuffer(sequence_base=1 << 32),
        lambda: {"agent-demo"},
    )
    assert receipt.status == "accepted"


@pytest.mark.asyncio
async def test_retained_sequence_from_another_room_is_not_replayed(session_factory):
    service, epoch = await setup(session_factory)
    buffer = EventBuffer(sequence_base=0)
    sequence = buffer.enqueue("agent-demo", "different-room", event())
    with pytest.raises(SessionError, match="belongs to another room") as failure:
        await service.submit_room_message(
            "agent-demo",
            "session-demo",
            "host-demo",
            epoch,
            "room-demo",
            "message",
            sequence,
            0,
            None,
            buffer,
            set,
        )
    assert failure.value.code == "NOT_AUTHORIZED"


@pytest.mark.asyncio
@pytest.mark.parametrize("same_room", [True, False])
async def test_replay_addresses_a_room_alias(session_factory, same_room):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        now = await service._now(db)
        membership = await db.get(ClientRoom, ("agent-client", "room-demo"))
        membership.joined_at = now - timedelta(minutes=1)
        if not same_room:
            db.add(
                Room(
                    id="alias-room",
                    matrix_room_id="!alias:example.test",
                    name="Alias",
                    description="",
                )
            )
            await db.flush()
        await db.execute(
            insert(room_agents).values(
                agent_id="agent-demo",
                room_id="room-demo" if same_room else "alias-room",
                alias="review-helper",
            )
        )
        await MessageStore().create(
            db,
            Message(
                room_id="room-demo",
                transport_event_id="alias-message",
                sender_id="@owner:example.test",
                sender_name="Owner",
                event_type="m.room.message",
                msgtype="m.text",
                body="@review-helper Please review",
                content={},
                sent_at=now,
            ),
            [],
        )

    async def submit():
        return await service.submit_room_message(
            "agent-demo",
            "session-demo",
            "host-demo",
            epoch,
            "room-demo",
            "alias-message",
            1,
            0,
            None,
            EventBuffer(sequence_base=1 << 32),
            set,
        )

    if same_room:
        assert (await submit()).status == "accepted"
    else:
        with pytest.raises(SessionError, match="does not address") as refused:
            await submit()
        assert refused.value.code == "ROOM_REPLAY_REFUSED"
