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
from switch_core.sessions.contract import HostEvent, Session
from switch_core.sessions.service import RoomGrant, SessionAuthority, SessionError

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
    assert [r.message_id for r in await service.room_reservations(AGENT)] == ["first"]


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
    with pytest.raises(SessionError) as gone:
        await service.discard_room_reservation(AGENT, ROOM, "first")
    assert gone.value.code == "NOT_FOUND"
