"""Who a room delivery belongs to, answered by the server rather than guessed.

A controller holds one inbound connection for its agent and routes every room
event over it, so before it hands an event to a session it has to know which
session is in that room. Its only local evidence is the files its sessions
wrote, and those outlive the sessions: a stopped session goes on claiming the
room it was working in and the controller routes the message to nobody.

These cover the answer and what the answer is worth afterwards — that a
delivery admitted here can still be made once the replay buffer holding it has
been trimmed, that an answer overtaken by a rebind is refused rather than
delivered twice, and that a room nothing holds starts exactly one session.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import SdkRoomAdmission, SdkSession, require_tenant_id
from switch_core.sessions.contract import HostEvent, Session, Snapshot
from switch_core.sessions.service import (
    ADMISSION_SECONDS,
    RoomGrant,
    SessionAuthority,
    SessionError,
)

from .test_authority import EXAMPLES, setup

AGENT = "agent-demo"
ROOM = "room-demo"
FIRST = ("session-demo", "host-demo")
SECOND = ("session-other", "host-other")


def _event(message_id: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=ROOM,
        bridge_id="bridge",
        payload=MessagePayload(
            addressed=True,
            sender="@owner:example.test",
            sender_name="Owner",
            message_id=message_id,
            body=f"Please look at {message_id}",
            timestamp=1,
        ),
    )


async def _second_session(service: SessionAuthority, grant: RoomGrant | None) -> str:
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": SECOND[0], "host_id": SECOND[1]}
    )
    snapshot = await service.acquire(AGENT, session, "claim-other", grant)
    return snapshot.session.epoch


async def _status(
    service: SessionAuthority, session_id: str, host_id: str, epoch: str, status: str
) -> None:
    snapshot = await service.snapshot(session_id, "owner")
    await service.ingest(
        AGENT,
        host_id,
        HostEvent(
            contract_version=1,
            event_id=f"host-{status}-{session_id}",
            session_id=session_id,
            epoch=epoch,
            host_sequence=1,
            occurred_at="2026-09-09T12:00:00Z",
            body={
                "type": "session.upsert",
                "session": snapshot.session.model_copy(
                    update={"status": status}
                ).model_dump(by_alias=True),
            },
        ),
    )


async def _lapse_lease(session_factory, session_id: str) -> None:
    async with session_factory() as db, db.begin():
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        row.lease_expires_at = datetime.now(UTC) - timedelta(minutes=1)


async def _reclaim(session_factory, session_id: str) -> None:
    """Put the room claim back on a session the binder took it off.

    Binding evicts every other claimant, so two sessions holding one room is
    not a state the service produces. It is what an eviction that never reached
    a session's stored state would leave behind, and the answer has to be safe
    in it.
    """
    async with session_factory() as db, db.begin():
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        snapshot = Snapshot.model_validate(row.snapshot)
        row.snapshot = snapshot.model_copy(
            update={"session": snapshot.session.model_copy(update={"room_ids": [ROOM]})}
        ).model_dump(by_alias=True)


async def _age_admission(
    session_factory, message_id: str, *, grant: bool, promise: bool
) -> None:
    """Move a reservation's clocks into the past, as waiting long enough would."""
    past = datetime.now(UTC) - timedelta(minutes=1)
    async with session_factory() as db, db.begin():
        row = await db.get(
            SdkRoomAdmission, (require_tenant_id(), AGENT, ROOM, message_id)
        )
        if grant:
            row.grant_expires_at = past
        if promise:
            row.expires_at = past


async def _discard_long_ago(session_factory, message_id: str) -> None:
    """Backdate a given-up delivery past the term its mark is kept for."""
    async with session_factory() as db, db.begin():
        row = await db.get(
            SdkRoomAdmission, (require_tenant_id(), AGENT, ROOM, message_id)
        )
        row.discarded_at = datetime.now(UTC) - timedelta(seconds=ADMISSION_SECONDS + 60)


async def _reserved(session_factory) -> list[tuple[str, bool]]:
    """Every row this agent has, delivered or not, oldest promise first."""
    async with session_factory() as db:
        rows = await db.scalars(
            select(SdkRoomAdmission)
            .where(
                SdkRoomAdmission.tenant_id == require_tenant_id(),
                SdkRoomAdmission.agent_id == AGENT,
            )
            .order_by(SdkRoomAdmission.sequence)
        )
        return [(row.message_id, row.consumed_at is not None) for row in rows]


@pytest.mark.asyncio
async def test_a_stopped_session_is_not_the_room_owner_but_a_crashed_host_still_is(
    session_factory,
) -> None:
    """The distinction a controller reading its own disk cannot make.

    All three sessions left the same claim behind them. The one still running
    is the room's; the one whose host died has not finished and is coming back
    to it, so the delivery waits rather than starting a rival; the one that
    stopped has left, and the room is free.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service, None)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)

    admission = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert (admission.status, admission.session_id) == ("owner", FIRST[0])
    assert (admission.host_id, admission.epoch) == (FIRST[1], first)

    await _status(service, FIRST[0], FIRST[1], first, "stopped")
    free = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert free.status == "none"
    assert free.grant_expires_at is not None

    await service.bind_room(AGENT, *SECOND, second, ROOM)
    await _lapse_lease(session_factory, SECOND[0])
    held = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert (held.status, held.grant_expires_at) == ("unavailable", None)
    # Named, so the controller that has this session can start it again rather
    # than wait for a host nothing else is going to bring back.
    assert (held.session_id, held.host_id) == SECOND


@pytest.mark.asyncio
async def test_a_delivery_is_still_made_after_the_replay_buffer_is_trimmed(
    session_factory,
) -> None:
    """What the reservation is for: the promise outliving the evidence.

    The controller holds the event while it asks who owns the room, and the
    buffer it was read from can be trimmed or renumbered in the meantime. The
    copy taken at admission is the one the session is finally told, so a
    submit carrying no usable position still lands, with the sender and body
    the server verified rather than the ones the caller offers now.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)

    receipt = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "first", sequence, False, EventBuffer()
    )
    assert receipt.status == "accepted"
    pending = await service.pending(AGENT, *FIRST, epoch)
    assert pending[0].origin.actor_id == "@owner:example.test"
    assert "Please look at first" in pending[0].body.text
    assert await service.room_reservations(AGENT) == []


@pytest.mark.asyncio
async def test_a_room_rebound_after_admission_refuses_the_delivery_and_keeps_it(
    session_factory,
) -> None:
    """An owner answer is not a licence to deliver once it is out of date.

    The sibling that bound the room took it while the controller was handing
    the event over. Delivering it anyway puts the message in a session the
    room no longer belongs to, and dropping the reservation with it would lose
    the only verified copy — so the submit is refused by a name that says to
    ask again, and the delivery is still owed.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service, None)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    admission = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert admission.session_id == FIRST[0]

    await service.bind_room(AGENT, *SECOND, second, ROOM)
    with pytest.raises(SessionError) as refused:
        await service.submit_room_message(
            AGENT, *FIRST, first, ROOM, "first", sequence, False, buffer
        )
    assert refused.value.code == "ROOM_MESSAGE_REASSIGNED"
    assert [r.message_id for r in await service.room_reservations(AGENT)] == ["first"]

    again = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert again.session_id == SECOND[0]
    receipt = await service.submit_room_message(
        AGENT, *SECOND, second, ROOM, "first", sequence, False, EventBuffer()
    )
    assert receipt.status == "accepted"
    assert await service.room_reservations(AGENT) == []


@pytest.mark.asyncio
async def test_two_deliveries_for_a_free_room_start_one_session_between_them(
    session_factory,
) -> None:
    """The race the grant exists to lose.

    Two messages arrive for a room nothing holds. Both would be answered
    `nobody is here, start one` if the answer were only a read, and the agent
    would end up with two sessions in one room receiving the same events with
    nothing to say which should reply. The second is told to wait instead, and
    once the granted session exists it is told where to send its message.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    first = buffer.enqueue(AGENT, ROOM, _event("first"))
    second = buffer.enqueue(AGENT, ROOM, _event("second"))
    await _status(service, FIRST[0], FIRST[1], epoch, "stopped")

    granted, refused = await asyncio.gather(
        service.admit_room(AGENT, ROOM, "first", first, True, buffer),
        service.admit_room(AGENT, ROOM, "second", second, True, buffer),
    )
    answers = sorted([granted.status, refused.status])
    assert answers == ["none", "unavailable"]

    winner = "first" if granted.status == "none" else "second"
    other = await _second_session(service, RoomGrant(ROOM, winner))
    settled = await service.admit_room(AGENT, ROOM, "second", second, True, buffer)
    assert (settled.status, settled.session_id) == ("owner", SECOND[0])
    assert settled.epoch == other


@pytest.mark.asyncio
async def test_a_controller_that_may_not_start_a_session_is_told_to_wait(
    session_factory,
) -> None:
    """Automatic sessions off is not the same as nobody being in the room.

    Nothing holds the room and nothing may be started for it, so there is no
    owner to name and no right to hand out. The delivery waits, and the
    verified copy is kept for whoever finally takes the room.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await _status(service, FIRST[0], FIRST[1], epoch, "stopped")

    admission = await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)
    assert (admission.status, admission.grant_expires_at) == ("unavailable", None)
    # Nothing to bring back: waiting on the setting is not waiting on a session.
    assert (admission.session_id, admission.host_id) == (None, None)
    assert [r.message_id for r in await service.room_reservations(AGENT)] == ["first"]


@pytest.mark.asyncio
async def test_a_session_stood_down_on_purpose_is_not_offered_for_restarting(
    session_factory,
) -> None:
    """A host that said it was going is not one that was killed.

    Both leave the room claimed by a session that has not finished, and only
    one of them is waiting to be brought back. Naming the other would restart a
    session whose host stopped it deliberately.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.quiesce(AGENT, *FIRST, epoch)

    admission = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert admission.status == "unavailable"
    assert (admission.session_id, admission.host_id) == (None, None)


@pytest.mark.asyncio
async def test_a_room_two_sessions_claim_names_neither_of_them(
    session_factory,
) -> None:
    """Which one to bring back is not a question this answer should guess at.

    Both are unfinished, both have the room, and neither has a host running
    it. Starting either would be picking a winner from a state nothing here
    can tell apart, so the delivery waits for the room to settle instead.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service, None)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_room(AGENT, *SECOND, second, ROOM)
    await _reclaim(session_factory, FIRST[0])
    await _lapse_lease(session_factory, FIRST[0])
    await _lapse_lease(session_factory, SECOND[0])

    admission = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert admission.status == "unavailable"
    assert (admission.session_id, admission.host_id) == (None, None)


@pytest.mark.asyncio
async def test_a_grant_is_spent_once_and_a_lapsed_one_is_not_an_owner(
    session_factory,
) -> None:
    """A grant that produced nothing must not read as a session that exists.

    The session was never created, so the room is still free and the next
    delivery is entitled to start one — but only because the grant lapsed
    unused. Had it been spent, the same read has to find the session it
    created rather than issue a second grant against it.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await _status(service, FIRST[0], FIRST[1], epoch, "stopped")
    assert (
        await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    ).status == "none"

    await _age_admission(session_factory, "first", grant=True, promise=False)
    with pytest.raises(SessionError) as lapsed:
        await _second_session(service, RoomGrant(ROOM, "first"))
    assert lapsed.value.code == "ROOM_GRANT_LAPSED"

    reissued = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert reissued.status == "none"
    epoch_other = await _second_session(service, RoomGrant(ROOM, "first"))
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]

    third = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": "session-third", "host_id": "host-third"}
    )
    with pytest.raises(SessionError) as spent:
        await service.acquire(AGENT, third, "claim-third", RoomGrant(ROOM, "first"))
    assert spent.value.code == "ROOM_GRANT_LAPSED"
    owner = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert (owner.status, owner.session_id, owner.epoch) == (
        "owner",
        SECOND[0],
        epoch_other,
    )


@pytest.mark.asyncio
async def test_an_event_the_server_cannot_verify_is_refused_not_promised(
    session_factory,
) -> None:
    """Nothing is reserved for an event the server has no copy of.

    The controller is told the evidence is gone on the call that would have
    created the promise, so it drops the delivery with a warning rather than
    holding a message the server will never be able to build.
    """
    service, epoch = await setup(session_factory)
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    with pytest.raises(SessionError) as missing:
        await service.admit_room(AGENT, ROOM, "first", 1, True, EventBuffer())
    assert missing.value.code == "ROOM_EVENT_UNAVAILABLE"
    assert await service.room_reservations(AGENT) == []


@pytest.mark.asyncio
async def test_an_expired_promise_is_reported_and_kept_until_it_is_given_up(
    session_factory,
) -> None:
    """Expiry stops the promise; it does not throw the evidence away.

    The controller is still holding the event, and taking the only verified
    copy out from under it on a clock would leave a message it can neither
    deliver nor account for. So the reservation is reported as over, stays
    usable while it is there, and goes when the controller says it has
    stopped holding it.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)

    await _age_admission(session_factory, "first", grant=False, promise=True)
    assert [
        (r.message_id, r.expired) for r in await service.room_reservations(AGENT)
    ] == [("first", True)]

    await service.discard_room_reservation(AGENT, ROOM, "first")
    assert await service.room_reservations(AGENT) == []
    # The controller's own call can be answered after it has stopped listening,
    # so saying so a second time has to mean the same as saying it once.
    await service.discard_room_reservation(AGENT, ROOM, "first")
    assert await service.room_reservations(AGENT) == []
    with pytest.raises(SessionError) as gone:
        await service.discard_room_reservation(AGENT, ROOM, "second")
    assert gone.value.code == "NOT_FOUND"


@pytest.mark.asyncio
async def test_a_given_up_delivery_cannot_be_made_by_the_session_holding_it(
    session_factory,
) -> None:
    """Giving up is the end of the delivery, not the end of the record of it.

    The controller hands the event to a session before that session submits it,
    so a delivery it has written off can still be in flight — and the event it
    was built from can still be in the buffer. With nothing left behind, the
    submit reads as one no admission was ever asked for, which is the shape of
    caller the room fence does not apply to, and the message is delivered after
    being reported undelivered.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    await _age_admission(session_factory, "first", grant=False, promise=True)
    await service.discard_room_reservation(AGENT, ROOM, "first")

    with pytest.raises(SessionError) as refused:
        await service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "first", sequence, False, buffer
        )

    assert refused.value.code == "ROOM_MESSAGE_ABANDONED"
    assert await service.pending(AGENT, *FIRST, epoch) == []
    # And the controller is told the same, so a redelivery from the stream is
    # settled rather than held for a room that will never be answered.
    with pytest.raises(SessionError) as again:
        await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert again.value.code == "ROOM_MESSAGE_ABANDONED"


@pytest.mark.asyncio
async def test_a_given_up_delivery_stops_being_kept_once_nothing_can_rebuild_it(
    session_factory,
) -> None:
    """The mark outlives the promise, then goes.

    It is only there to outlive every copy of the event there is. Timed from
    when the delivery was given up rather than from when the promise ran out,
    which is already past by then.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    await _age_admission(session_factory, "first", grant=False, promise=True)
    await service.discard_room_reservation(AGENT, ROOM, "first")

    second = buffer.enqueue(AGENT, ROOM, _event("second"))
    await service.admit_room(AGENT, ROOM, "second", second, True, buffer)
    assert [message for message, _ in await _reserved(session_factory)] == [
        "first",
        "second",
    ]

    await _discard_long_ago(session_factory, "first")
    await service.admit_room(AGENT, ROOM, "second", second, True, buffer)

    assert [message for message, _ in await _reserved(session_factory)] == ["second"]


@pytest.mark.asyncio
async def test_a_given_up_delivery_is_still_refused_once_its_mark_has_gone(
    session_factory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The mark is dropped on the promise that the event is unreadable by then.

    Nothing else arrives for this agent, so nothing appends and nothing would
    otherwise expire the event it was built from. The delivery has to be
    refused on the copy being gone rather than on the mark still being there.
    """
    clock = {"now": 1000.0}
    monkeypatch.setattr(
        "switch_core.bridges.agent.protocol.event_buffer.time.monotonic",
        lambda: clock["now"],
    )
    service, epoch = await setup(session_factory)
    buffer = EventBuffer(retention_seconds=60)
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    kept = buffer.enqueue(AGENT, ROOM, _event("kept"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    await service.admit_room(AGENT, ROOM, "kept", kept, True, buffer)
    await _age_admission(session_factory, "first", grant=False, promise=True)
    await service.discard_room_reservation(AGENT, ROOM, "first")

    clock["now"] += 61
    await _discard_long_ago(session_factory, "first")
    # An admission for a delivery already reserved prunes the mark without any
    # event being appended, so this is the whole of what ages the buffer.
    await service.admit_room(AGENT, ROOM, "kept", kept, True, buffer)
    assert [message for message, _ in await _reserved(session_factory)] == ["kept"]

    with pytest.raises(SessionError) as refused:
        await service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "first", sequence, False, buffer
        )

    assert refused.value.code == "ROOM_EVENT_UNAVAILABLE"
    assert await service.pending(AGENT, *FIRST, epoch) == []


@pytest.mark.asyncio
async def test_a_delivered_message_stops_being_kept_once_its_promise_is_over(
    session_factory,
) -> None:
    """The table is written to on every addressed room message, so it is cleared here.

    A row outlives the delivery it describes on purpose: while the promise
    stands, the copy it holds is what a redelivery is built from. Past that it
    is answering a question nobody can still ask — the same message arriving
    again is verified afresh, and the command it became is what stops it being
    answered twice. One that nothing has taken is left alone: it is the only
    record that a message went undelivered, and the controller is told so and
    gives it up by name.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    first = buffer.enqueue(AGENT, ROOM, _event("first"))
    second = buffer.enqueue(AGENT, ROOM, _event("second"))
    third = buffer.enqueue(AGENT, ROOM, _event("third"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", first, True, buffer)
    await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "first", first, False, buffer
    )
    await service.admit_room(AGENT, ROOM, "second", second, True, buffer)
    assert await _reserved(session_factory) == [("first", True), ("second", False)]

    await _age_admission(session_factory, "first", grant=False, promise=True)
    await _age_admission(session_factory, "second", grant=False, promise=True)
    await service.admit_room(AGENT, ROOM, "third", third, True, buffer)
    assert await _reserved(session_factory) == [("second", False), ("third", False)]
