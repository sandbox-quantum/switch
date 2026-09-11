from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from switch_core.db.models import SdkSession, require_tenant_id
from switch_core.sessions.service import SessionError
from tests.switch_core.sessions.test_authority import (
    answer,
    command,
    host_event,
    opened,
    setup,
)


@pytest.mark.asyncio
async def test_expiry_does_not_grant_recovery(session_factory):
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    with pytest.raises(SessionError, match="previous execution"):
        await service.recover(
            "agent-demo", "session-demo", "host-demo", epoch, "recovery", 0
        )
    with pytest.raises(SessionError, match="another host"):
        await service.recover(
            "agent-demo", "session-demo", "other-host", epoch, "recovery", 0
        )


@pytest.mark.asyncio
async def test_recovery_closes_callbacks_and_never_replays_uncertain_answers(
    session_factory,
):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    command = answer(epoch, "answer-demo")
    await service.submit(command, user_id="owner", bridge_id=None)
    await service.pending("agent-demo", "session-demo", "host-demo", epoch)
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    with pytest.raises(SessionError, match="quiesced"):
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)
    results = await asyncio.gather(
        *(
            service.recover(
                "agent-demo", "session-demo", "host-demo", epoch, operation, 2
            )
            for operation in ("first", "second")
        ),
        return_exceptions=True,
    )
    winners = [result for result in results if not isinstance(result, Exception)]
    assert len(winners) == 1
    snapshot = winners[0]
    assert snapshot.session.epoch != epoch
    assert snapshot.requests[0].state == "closed"
    assert snapshot.requests[0].result.outcome == "interrupted"
    status = next(s for s in snapshot.command_statuses if s.command_id == "answer-demo")
    assert status.status == "unknown"
    assert (
        await service.pending(
            "agent-demo", "session-demo", "host-demo", snapshot.session.epoch
        )
        == []
    )
    operation = "first" if results[0] is snapshot else "second"
    retried = await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, operation, 2
    )
    assert retried == snapshot
    with pytest.raises(SessionError, match="generation changed"):
        await service.renew("agent-demo", "session-demo", "host-demo", epoch)


@pytest.mark.asyncio
async def test_quiesced_delivery_reconciles_lost_ack_before_epoch_change(
    session_factory,
):
    service, epoch = await setup(session_factory)
    event = host_event(
        epoch,
        1,
        {"type": "notice", "level": "info", "code": "TEST", "message": "Saved"},
    )
    assert await service.ingest("agent-demo", "host-demo", event) == 1
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    assert await service.ingest("agent-demo", "host-demo", event, reconcile=True) == 1
    with pytest.raises(SessionError, match="every durable upload"):
        await service.recover(
            "agent-demo", "session-demo", "host-demo", epoch, "recover", 0
        )
    snapshot = await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "recover", 1
    )
    with pytest.raises(SessionError, match="generation changed"):
        await service.ingest("agent-demo", "host-demo", event, reconcile=True)
    assert snapshot.session.epoch != epoch


@pytest.mark.asyncio
async def test_acquisition_ack_retry_is_idempotent_and_competing_claim_is_denied(
    session_factory,
):
    service, _ = await setup(session_factory)
    original = await service.snapshot("session-demo", "owner")
    session = original.session.model_copy(update={"session_id": "new-session"})
    acquired = await service.acquire("agent-demo", session, "operation")
    assert await service.acquire("agent-demo", session, "operation") == acquired
    with pytest.raises(SessionError, match="live host"):
        await service.acquire("agent-demo", session, "competitor")
    with pytest.raises(SessionError, match="Acquisition host changed"):
        await service.acquire(
            "agent-demo",
            session.model_copy(update={"host_id": "another-host"}),
            "operation",
        )


@pytest.mark.asyncio
async def test_lifecycle_commands_are_authorized_durable_and_fenced(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    for command_id, body in (
        ("interrupt", {"type": "turn.interrupt", "turnId": "turn-demo"}),
        ("stop", {"type": "session.stop"}),
    ):
        control = command(epoch, command_id, body)
        with pytest.raises(SessionError, match="owner"):
            await service.submit(control, user_id="outsider", bridge_id=None)
        receipt = await service.submit(control, user_id="owner", bridge_id=None)
        assert receipt.status == "accepted"
        assert await service.submit(control, user_id="owner", bridge_id=None) == receipt
        assert control in await service.pending(
            "agent-demo", "session-demo", "host-demo", epoch
        )
    with pytest.raises(SessionError, match="no longer running"):
        await service.submit(
            command(epoch, "old-turn", {"type": "turn.interrupt", "turnId": "other"}),
            user_id="owner",
            bridge_id=None,
        )
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    snapshot = await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "recovery", 2
    )
    statuses = {entry.command_id: entry.status for entry in snapshot.command_statuses}
    assert statuses["interrupt"] == statuses["stop"] == "unknown"
    assert (
        await service.pending(
            "agent-demo", "session-demo", "host-demo", snapshot.session.epoch
        )
        == []
    )


@pytest.mark.asyncio
async def test_reset_authorization_busy_state_and_epoch_reconciliation(session_factory):
    service, epoch = await setup(session_factory)
    snapshot = await service.snapshot("session-demo", "owner")
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
            {
                "type": "session.upsert",
                "session": ready.model_dump(by_alias=True),
            },
        ),
    )
    reset = command(epoch, "reset-demo", {"type": "session.reset"})
    with pytest.raises(SessionError):
        await service.submit(reset, user_id="outsider", bridge_id=None)
    await service.submit(reset, user_id="owner", bridge_id=None)
    assert (await service.pending("agent-demo", "session-demo", "host-demo", epoch))[
        0
    ] == reset
    await service.quiesce("agent-demo", "session-demo", "host-demo", epoch)
    recovered = await service.recover(
        "agent-demo", "session-demo", "host-demo", epoch, "reset-epoch", 1
    )
    assert recovered.session.epoch != epoch
    assert (
        next(
            s for s in recovered.command_statuses if s.command_id == "reset-demo"
        ).status
        == "unknown"
    )
    assert (
        await service.pending(
            "agent-demo", "session-demo", "host-demo", recovered.session.epoch
        )
        == []
    )
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(
            recovered.session.epoch,
            1,
            {
                "type": "command.result",
                "commandId": "reset-demo",
                "status": "applied",
                "code": None,
                "message": None,
            },
        ).model_copy(update={"event_id": "reset-confirmed"}),
    )
    assert (
        await service.command_status("session-demo", "reset-demo", "owner")
    ).status == "applied"
    with pytest.raises(SessionError, match="generation changed"):
        await service.submit(
            command(epoch, "stale-reset", {"type": "session.reset"}),
            user_id="owner",
            bridge_id=None,
        )


@pytest.mark.asyncio
async def test_reset_rejects_pending_questions(session_factory):
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    snapshot = await service.snapshot("session-demo", "owner")
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
            3,
            {
                "type": "session.upsert",
                "session": ready.model_dump(by_alias=True),
            },
        ),
    )
    with pytest.raises(SessionError, match="Finish or interrupt"):
        await service.submit(
            command(epoch, "busy-reset", {"type": "session.reset"}),
            user_id="owner",
            bridge_id=None,
        )


@pytest.mark.asyncio
async def test_model_catalog_validation_and_compaction_capability(session_factory):
    service, epoch = await setup(session_factory)
    snapshot = await service.snapshot("session-demo", "owner")
    data = snapshot.session.model_dump(by_alias=True)
    data.update(
        status="ready",
        models=[
            {
                "id": "model-demo",
                "label": "Demo",
                "options": {"effort": ["low", "high"]},
            }
        ],
    )
    data["capabilities"].update(modelChange=True, compact=False)
    await service.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 1, {"type": "session.upsert", "session": data}),
    )
    for body in (
        {"type": "session.model.set", "modelId": "invented", "options": {}},
        {
            "type": "session.model.set",
            "modelId": "model-demo",
            "options": {"effort": "invented"},
        },
        {"type": "session.compact"},
    ):
        with pytest.raises(SessionError):
            await service.submit(
                command(epoch, "invalid", body), user_id="owner", bridge_id=None
            )
    result = await service.submit(
        command(
            epoch,
            "valid-model",
            {
                "type": "session.model.set",
                "modelId": "model-demo",
                "options": {"effort": "high"},
            },
        ),
        user_id="owner",
        bridge_id=None,
    )
    assert result.status == "accepted"
