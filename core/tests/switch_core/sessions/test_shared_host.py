from __future__ import annotations

import pytest

from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import ClientRoom, Room, SdkSession, require_tenant_id
from switch_core.sessions.service import SessionError
from tests.switch_core.sessions.test_authority import host_event, setup
from tests.switch_core.sessions.test_room_messages import event


async def shared_host(session_factory):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        db.add(
            Room(
                id="room-other",
                matrix_room_id="!other:example.test",
                name="Other room",
                description="test",
                bridge_id="bridge",
                external_channel_id="channel-other",
            )
        )
        await db.flush()
        db.add_all(
            ClientRoom(client_id=client_id, room_id="room-other")
            for client_id in ("agent-client", "actor-client")
        )
    original = await service.snapshot("session-demo", "owner")
    other = await service.acquire(
        "agent-demo",
        original.session.model_copy(
            update={"session_id": "session-other", "room_ids": ["room-other"]}
        ),
    )
    connections = ConnectionRegistry()
    for suffix, generation in (("demo", epoch), ("other", other.session.epoch)):
        connection = connections.open(
            agent_id="agent-demo",
            connection_id=f"connection-{suffix}",
            scope="single",
            delivery_filter="addressed",
            spawn_capable=False,
            cursor=0,
            declaration=ClientDeclaration(),
        )
        connections.claim_room(connection, f"room-{suffix}")
        assert await service.bind_connection(
            "agent-demo",
            f"session-{suffix}",
            "host-demo",
            generation,
            connection.id,
            connections,
        ) == [f"room-{suffix}"]
    return service, epoch, other.session.epoch, connections


@pytest.mark.asyncio
async def test_shared_host_keeps_room_connections_and_deliveries_separate(
    session_factory,
):
    service, epoch, other_epoch, connections = await shared_host(session_factory)
    assert epoch != other_epoch
    with pytest.raises(SessionError) as error:
        await service.bind_connection(
            "agent-demo",
            "session-demo",
            "host-demo",
            epoch,
            "connection-other",
            connections,
        )
    assert error.value.code == "FENCING_REQUIRED"
    with pytest.raises(SessionError) as error:
        await service.bind_connection(
            "agent-demo",
            "session-demo",
            "host-demo",
            other_epoch,
            "connection-demo",
            connections,
        )
    assert error.value.code == "STALE_EPOCH"

    buffer = EventBuffer()
    for suffix, generation in (("demo", epoch), ("other", other_epoch)):
        message = event().model_copy(update={"room_id": f"room-{suffix}"})
        message.payload.thread_id = f"thread-{suffix}"
        sequence = buffer.enqueue("agent-demo", message.room_id, message)
        receipt = await service.submit_room_message(
            "agent-demo",
            f"session-{suffix}",
            "host-demo",
            generation,
            message.room_id,
            "message",
            sequence,
            0,
            None,
            buffer,
        )
        assert receipt.status == "accepted"

    for suffix, generation in (("demo", epoch), ("other", other_epoch)):
        pending = await service.pending(
            "agent-demo",
            f"session-{suffix}",
            "host-demo",
            generation,
        )
        assert len(pending) == 1
        assert pending[0].origin.room_id == f"room-{suffix}"
        assert pending[0].origin.thread_id == f"thread-{suffix}"
        assert pending[0].epoch == generation
        async with session_factory() as db:
            row = await db.get(SdkSession, (require_tenant_id(), f"session-{suffix}"))
            assert row.connection_id == f"connection-{suffix}"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["recover", "retire"])
async def test_shared_host_fences_one_session_without_interrupting_its_sibling(
    session_factory,
    action,
):
    service, epoch, other_epoch, connections = await shared_host(session_factory)
    sibling_before = await service.snapshot("session-other", "owner")
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    with pytest.raises(SessionError, match="quiesced"):
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)
    await service.renew("agent-demo", "session-other", "host-demo", other_epoch)
    if action == "recover":
        result = await service.recover(
            "agent-demo",
            "session-demo",
            "host-demo",
            epoch,
            "recover-demo",
            0,
        )
        await service.bind_connection(
            "agent-demo",
            "session-demo",
            "host-demo",
            result.session.epoch,
            "connection-demo",
            connections,
        )
    else:
        result = await service.retire("session-demo", "owner", epoch)
    assert result.session.epoch != epoch
    with pytest.raises(SessionError) as error:
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)
    assert error.value.code == "STALE_EPOCH"
    assert await service.snapshot("session-other", "owner") == sibling_before
    async with session_factory() as db:
        sibling = await db.get(SdkSession, (require_tenant_id(), "session-other"))
        assert sibling.connection_id == "connection-other"
        assert sibling.recovery.get("quiesced") is not True
    message = host_event(
        other_epoch,
        1,
        {"type": "notice", "level": "info", "code": "TEST", "message": "Still running"},
    ).model_copy(update={"session_id": "session-other"})
    assert await service.ingest("agent-demo", "host-demo", message) == 1


@pytest.mark.asyncio
async def test_shared_host_room_control_targets_only_the_bound_session(session_factory):
    service, epoch, other_epoch, connections = await shared_host(session_factory)
    snapshot = await service.snapshot("session-other", "owner")
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
            other_epoch,
            1,
            {"type": "session.upsert", "session": ready.model_dump(by_alias=True)},
        ).model_copy(update={"session_id": "session-other"}),
    )
    receipt = await service.submit_room_control(
        "agent-demo",
        "room-other",
        "reset",
        "@owner:example.test",
        "reset-message",
        "thread-other",
        connections,
    )
    assert receipt.status == "accepted"
    assert await service.pending("agent-demo", "session-demo", "host-demo", epoch) == []
    pending = await service.pending(
        "agent-demo",
        "session-other",
        "host-demo",
        other_epoch,
    )
    assert len(pending) == 1
    assert pending[0].command_id == receipt.command_id
    assert pending[0].body.type == "session.reset"
    assert pending[0].origin.room_id == "room-other"
    assert pending[0].origin.thread_id == "thread-other"
