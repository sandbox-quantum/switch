from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    Room,
    SdkSession,
    SdkSessionCommand,
    User,
    require_tenant_id,
)
from switch_core.sessions.contract import (
    Command,
    HostEvent,
    Session,
)
from switch_core.sessions.service import SessionAuthority, SessionError

EXAMPLES = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "console/packages/shared/src/session-v1/examples.json"
    ).read_text()
)


async def setup(session_factory):
    async with session_factory() as db, db.begin():
        user = User(id="owner", name="Owner", email="owner@example.test", role="user")
        db.add(user)
        await db.flush()
        key = ApiKey(
            user_id=user.id,
            key_hash=uuid.uuid4().hex,
            encrypted_key="",
            label="unused fixture",
            type="agent",
        )
        client = Client(
            id="agent-client",
            matrix_user_id="@agent:example.test",
            display_name="Agent",
            type="agent",
        )
        bridge_client = Client(
            id="bridge-client",
            matrix_user_id="@bridge:example.test",
            display_name="Bridge",
            type="bridge",
        )
        actor = Client(
            id="actor-client",
            matrix_user_id="@owner:example.test",
            display_name="Owner",
            type="user",
        )
        outsider = Client(
            id="outsider-client",
            matrix_user_id="@outsider:example.test",
            display_name="Viewer",
            type="user",
        )
        db.add_all([key, client, bridge_client, actor, outsider])
        await db.flush()
        agent = Agent(
            id="agent-demo",
            name="agent-demo",
            description="test agent",
            agent_type="session_addressable",
            connector_type="codex",
            integration_profile={},
            client_id=client.id,
            api_key_id=key.id,
            owner_id=user.id,
        )
        bridge = CollaborationBridge(
            id="bridge",
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        db.add_all([agent, bridge])
        await db.flush()
        room = Room(
            id="room-demo",
            matrix_room_id="!room:example.test",
            name="Test room",
            description="test",
            bridge_id=bridge.id,
            external_channel_id="channel-demo",
        )
        db.add(room)
        await db.flush()
        db.add_all(
            [
                ClientRoom(client_id=c.id, room_id=room.id)
                for c in [client, actor, outsider]
            ]
        )
        external = ExternalUser(
            id="external-owner",
            bridge_id=bridge.id,
            external_user_id="platform-owner",
            external_username="owner",
            client_id=actor.id,
        )
        db.add(external)
        await db.flush()
        db.add(ExternalUserClaim(external_user_id=external.id, user_id=user.id))
    service = SessionAuthority(session_factory)
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"])
    initial = await service.acquire("agent-demo", session)
    return service, initial.session.epoch


def host_event(epoch, sequence, body):
    return HostEvent(
        contract_version=1,
        event_id=f"host-{sequence}",
        session_id="session-demo",
        epoch=epoch,
        host_sequence=sequence,
        occurred_at="2026-09-09T12:00:00Z",
        body=body,
    )


def command(epoch, command_id, body, *, actor="owner", surface="console"):
    return Command(
        contract_version=1,
        command_id=command_id,
        session_id="session-demo",
        epoch=epoch,
        origin={
            "surface": surface,
            "actorId": actor,
            "roomId": "room-demo",
            "threadId": None,
            "messageId": None,
        },
        body=body,
    )


async def opened(service, epoch):
    message = command(
        epoch,
        "message-demo",
        {
            "type": "message.send",
            "text": "Run tests",
            "attachments": [],
            "delivery": "queue",
        },
    )
    await service.submit(message, user_id="owner", bridge_id=None)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            1,
            {
                "type": "turn.upsert",
                "turnId": "turn-demo",
                "status": "running",
                "commandId": "message-demo",
            },
        ),
    )
    await service.ingest(
        "agent-demo", "host-demo", host_event(epoch, 2, EXAMPLES["hostRequest"]["body"])
    )


def answer(epoch, command_id, *, actor="owner", surface="console"):
    return command(
        epoch,
        command_id,
        EXAMPLES["platformAnswer"]["body"],
        actor=actor,
        surface=surface,
    )


async def test_authorized_answer_reserves_once_across_competing_workers(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    second_worker = SessionAuthority(session_factory)
    results = await asyncio.gather(
        service.submit(answer(epoch, "first"), user_id="owner", bridge_id=None),
        second_worker.submit(answer(epoch, "second"), user_id="owner", bridge_id=None),
        return_exceptions=True,
    )
    accepted = [r for r in results if not isinstance(r, Exception)]
    assert len(accepted) == 1
    assert (
        next(r for r in results if isinstance(r, SessionError)).code == "REQUEST_BUSY"
    )
    accepted_id = accepted[0].command_id
    assert (
        await service.submit(
            answer(epoch, accepted_id), user_id="owner", bridge_id=None
        )
    ).status == "accepted"
    snapshot = await second_worker.snapshot("session-demo", "owner")
    assert snapshot.requests[0].decided_by.command_id == accepted_id
    assert snapshot.requests[0].state == "submitting"
    pending = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert [c.command_id for c in pending].count(accepted_id) == 1


async def test_room_viewer_cannot_reserve_but_verified_owner_can(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    with pytest.raises(SessionError) as failure:
        await service.submit(
            answer(epoch, "outsider", actor="@outsider:example.test", surface="slack"),
            user_id=None,
            bridge_id="bridge",
        )
    assert failure.value.code == "NOT_AUTHORIZED"
    assert (await service.snapshot("session-demo", "owner")).requests[0].state == "open"
    result = await service.submit(
        answer(epoch, "owner-answer", actor="@owner:example.test", surface="slack"),
        user_id=None,
        bridge_id="bridge",
    )
    assert result.status == "accepted"
    async with session_factory() as db:
        assert (
            await db.get(
                SdkSessionCommand, (require_tenant_id(), "session-demo", "outsider")
            )
            is None
        )


async def test_host_cannot_forge_a_settlement_and_replay_keeps_confirmed_actor(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    settled = {
        "type": "request.settled",
        "requestId": "request-demo",
        "revision": 2,
        "outcome": "answered",
        "commandId": "decision",
        "result": {"kind": "approval", "optionId": "allow-once"},
    }
    with pytest.raises(SessionError):
        await service.ingest("agent-demo", "host-demo", host_event(epoch, 3, settled))
    await service.submit(answer(epoch, "decision"), user_id="owner", bridge_id=None)
    event = host_event(epoch, 3, settled)
    assert await service.ingest("agent-demo", "host-demo", event) == 3
    assert await service.ingest("agent-demo", "host-demo", event) == 3
    snapshot = await SessionAuthority(session_factory).snapshot("session-demo", "owner")
    assert snapshot.requests[0].state == "resolved"
    assert snapshot.requests[0].decided_by.actor_id == "owner"
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            epoch,
            4,
            {
                "type": "command.result",
                "commandId": "decision",
                "status": "applied",
                "code": None,
                "message": None,
            },
        ),
    )
    assert "decision" not in [
        c.command_id
        for c in await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    ]
    with pytest.raises(SessionError) as conflict:
        await service.ingest(
            "agent-demo",
            "host-demo",
            event.model_copy(update={"event_id": "different"}),
        )
    assert conflict.value.code == "IDEMPOTENCY_CONFLICT"


async def test_revoked_room_membership_blocks_callback_before_reservation(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db, db.begin():
        await db.delete(await db.get(ClientRoom, ("actor-client", "room-demo")))
    with pytest.raises(SessionError):
        await service.submit(
            answer(epoch, "revoked", actor="@owner:example.test", surface="slack"),
            user_id=None,
            bridge_id="bridge",
        )
    assert (await service.snapshot("session-demo", "owner")).requests[0].state == "open"


async def test_expired_host_cannot_execute_or_renew_with_a_stale_lease(session_factory):
    service, epoch = await setup(session_factory)
    with pytest.raises(SessionError) as conflict:
        await service.renew("another-agent", "session-demo", "host-demo", epoch)
    assert conflict.value.code == "NOT_AUTHORIZED"
    with pytest.raises(SessionError) as conflict:
        await service.renew("agent-demo", "session-demo", "host-demo", "stale")
    assert conflict.value.code == "STALE_EPOCH"

    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    with pytest.raises(SessionError) as conflict:
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)
    assert conflict.value.code == "HOST_OFFLINE"
    with pytest.raises(SessionError) as conflict:
        await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert conflict.value.code == "HOST_OFFLINE"


async def test_cancellation_cannot_be_confirmed_as_approval(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    request = (await service.snapshot("session-demo", "owner")).requests[0]
    value = request.model_dump(by_alias=True, exclude={"decided_by", "result"})
    value["requestId"] = "cancel-request"
    value["content"]["options"] = [
        {"optionId": "cancel", "label": "Cancel", "decision": "cancel"}
    ]
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 3, {"type": "request.opened", "request": value}),
    )
    decision = command(
        epoch,
        "cancel",
        {
            "type": "request.answer",
            "requestId": "cancel-request",
            "expectedRevision": 1,
            "answer": {"kind": "approval", "optionId": "cancel"},
        },
    )
    await service.submit(decision, user_id="owner", bridge_id=None)
    settlement = {
        "type": "request.settled",
        "requestId": "cancel-request",
        "revision": 2,
        "commandId": "cancel",
        "outcome": "answered",
        "result": {"kind": "approval", "optionId": "cancel"},
    }
    with pytest.raises(SessionError) as invalid:
        await service.ingest(
            "agent-demo", "host-demo", host_event(epoch, 4, settlement)
        )
    assert invalid.value.code == "INVALID_ANSWER"
    settlement.update(outcome="cancelled", result=None)
    await service.ingest("agent-demo", "host-demo", host_event(epoch, 4, settlement))
    request = (await service.snapshot("session-demo", "owner")).requests[1]
    assert request.state == "closed"
    assert request.result.outcome == "cancelled"
    assert request.result.result is None
    assert request.decided_by.actor_id == "owner"


@pytest.mark.asyncio
async def test_owner_can_retire_expired_unknown_session_without_replay(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    with pytest.raises(SessionError, match="owner"):
        await service.retire("session-demo", "outsider", epoch)
    with pytest.raises(SessionError, match="active host"):
        await service.retire("session-demo", "owner", epoch)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    retired = await service.retire("session-demo", "owner", epoch)
    assert retired.session.retired
    assert retired.session.epoch != epoch
    assert retired.session.connectivity == "offline"
    assert retired.session.status == "error"
    assert retired.session.pending_request_ids == []
    assert all(request.state == "closed" for request in retired.requests)
    assert any(status.status == "unknown" for status in retired.command_statuses)
    assert retired.turns
    assert retired.requests
    assert await service.retire("session-demo", "owner", epoch) == retired
    with pytest.raises(SessionError, match="cannot resume"):
        await service.recover(
            "agent-demo", "session-demo", "host-demo", epoch, "recover-retired", 0
        )
    with pytest.raises(SessionError):
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)


async def test_request_expiry_queues_one_cancellation_without_answering(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    initial = (await service.snapshot("session-demo", "owner")).requests[0]
    assert initial.expires_at is not None
    assert datetime.fromisoformat(initial.expires_at) > datetime.now(UTC)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        snapshot = dict(row.snapshot)
        requests = [dict(request) for request in snapshot["requests"]]
        requests[0]["expiresAt"] = (
            datetime.now(UTC) - timedelta(seconds=1)
        ).isoformat()
        snapshot["requests"] = requests
        row.snapshot = snapshot
    first = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    second = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    cancellation = [
        command for command in first if command.body.type == "turn.interrupt"
    ]
    assert len(cancellation) == 1
    assert cancellation[0].command_id in [command.command_id for command in second]
    assert cancellation[0].origin.actor_id == "switch-session-authority"
    snapshot = await service.snapshot("session-demo", "owner")
    assert snapshot.requests[0].state == "open"
    assert snapshot.requests[0].result is None
    with pytest.raises(SessionError, match="expired"):
        await service.submit(answer(epoch, "too-late"), user_id="owner", bridge_id=None)


async def test_reserved_answer_is_not_cancelled_by_request_expiry(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    await service.submit(answer(epoch, "winner"), user_id="owner", bridge_id=None)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        snapshot = dict(row.snapshot)
        requests = [dict(request) for request in snapshot["requests"]]
        requests[0]["expiresAt"] = (
            datetime.now(UTC) - timedelta(seconds=1)
        ).isoformat()
        snapshot["requests"] = requests
        row.snapshot = snapshot
    commands = await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    assert not any(command.body.type == "turn.interrupt" for command in commands)
