"""A session asking Switch for the room work it already owns.

Room deliveries reach a session because the controller holding the agent's one
inbound connection hands them over. A worker whose controller has gone — killed,
or stood down by another one that took the connection — is still the session the
server says is in the room, and there is nobody left to hand it anything. These
cover it asking for its own work instead, and the part that makes asking safe:
one order for the room whichever way a delivery arrives at submission.

The order cannot be the position the delivery carries. That belongs to the
replay stream, which starts again from one every time the server does, so a
delivery promised before a restart and one promised after it compare backwards.
It is taken from when the promise was written down, with the message id to break
ties.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.bridges.agent.api.session_routes import router as host_router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import (
    get_collab_lifecycle as host_lifecycle,
)
from switch_core.bridges.agent.dependencies import get_session_factory as host_factory
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import (
    Agent,
    ClientRoom,
    Room,
    SdkRoomAdmission,
    SdkSession,
    require_tenant_id,
)
from switch_core.sessions.contract import Session, Snapshot
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionAuthority, SessionError

from .test_authority import EXAMPLES, setup

AGENT = "agent-demo"
ROOM = "room-demo"
SPARE = "room-spare"
FIRST = ("session-demo", "host-demo")
SECOND = ("session-other", "host-other")


def _event(room_id: str, message_id: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
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


async def _second_session(service: SessionAuthority) -> str:
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": SECOND[0], "host_id": SECOND[1]}
    )
    snapshot = await service.acquire(AGENT, session, "claim-other", None)
    return snapshot.session.epoch


async def _add_room(session_factory, room_id: str) -> None:
    async with session_factory() as db, db.begin():
        db.add(
            Room(
                id=room_id,
                matrix_room_id=f"!{room_id}:example.test",
                name=room_id,
                description="test",
                bridge_id="bridge",
                external_channel_id=f"channel-{room_id}",
            )
        )
        await db.flush()
        db.add(ClientRoom(client_id="agent-client", room_id=room_id))


async def _holds(session_factory, session_id: str, room_ids: list[str]) -> None:
    """Put a session in more rooms than the binder will give it.

    One binding replaces the last, so a session holding two rooms is not a
    state the service produces on its own. The pull has to be bounded and fair
    across whatever the snapshot says, so it is written directly here.
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
            update={
                "session": snapshot.session.model_copy(update={"room_ids": room_ids})
            }
        ).model_dump(by_alias=True)


async def _promised_at(
    session_factory, room_id: str, message_id: str, *, minutes_ago: float
) -> None:
    async with session_factory() as db, db.begin():
        row = await db.get(
            SdkRoomAdmission, (require_tenant_id(), AGENT, room_id, message_id)
        )
        row.created_at = datetime.now(UTC) - timedelta(minutes=minutes_ago)


async def _promise_run_out(session_factory, room_id: str, message_id: str) -> None:
    async with session_factory() as db, db.begin():
        row = await db.get(
            SdkRoomAdmission, (require_tenant_id(), AGENT, room_id, message_id)
        )
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)


async def _lapse_lease(session_factory, session_id: str) -> None:
    async with session_factory() as db, db.begin():
        row = await db.scalar(
            select(SdkSession).where(
                SdkSession.tenant_id == require_tenant_id(),
                SdkSession.id == session_id,
            )
        )
        row.lease_expires_at = datetime.now(UTC) - timedelta(minutes=1)


@pytest.mark.asyncio
async def test_a_session_is_told_the_deliveries_its_own_rooms_still_owe(
    session_factory,
) -> None:
    """The work a worker can ask for is the work the server says is already its.

    Not the agent's: a sibling's room is answered by the sibling, and a pull
    that reported it would have two sessions racing for the same delivery.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _add_room(session_factory, SPARE)
    buffer = EventBuffer()
    mine = buffer.enqueue(AGENT, ROOM, _event(ROOM, "mine"))
    theirs = buffer.enqueue(AGENT, SPARE, _event(SPARE, "theirs"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_room(AGENT, *SECOND, second, SPARE)
    await service.admit_room(AGENT, ROOM, "mine", mine, False, buffer)
    await service.admit_room(AGENT, SPARE, "theirs", theirs, False, buffer)

    held = await service.session_room_reservations(AGENT, *FIRST, first)
    assert [(r.room_id, r.message_id, r.expired) for r in held] == [
        (ROOM, "mine", False)
    ]
    sibling = await service.session_room_reservations(AGENT, *SECOND, second)
    assert [r.message_id for r in sibling] == ["theirs"]

    # Made, and no longer owed.
    await service.submit_room_message(
        AGENT, *FIRST, first, ROOM, "mine", mine, False, buffer
    )
    assert await service.session_room_reservations(AGENT, *FIRST, first) == []


@pytest.mark.asyncio
async def test_a_pull_answers_the_host_holding_the_lease_and_nobody_else(
    session_factory,
) -> None:
    """The read is a room's contents, so it is fenced like the write would be.

    Each of these is a caller that could otherwise read the work of a session
    it does not run, or of one that has stopped running at all.
    """
    service, first = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)

    with pytest.raises(SessionError) as impostor:
        await service.session_room_reservations(
            AGENT, FIRST[0], "host-elsewhere", first
        )
    assert impostor.value.code == "NOT_AUTHORIZED"

    with pytest.raises(SessionError) as stale:
        await service.session_room_reservations(AGENT, *FIRST, "epoch-before")
    assert stale.value.code == "STALE_EPOCH"

    await service.quiesce(AGENT, *FIRST, first)
    with pytest.raises(SessionError) as quiesced:
        await service.session_room_reservations(AGENT, *FIRST, first)
    assert quiesced.value.code == "HOST_OFFLINE"


@pytest.mark.asyncio
async def test_a_session_whose_host_has_gone_cannot_pull_on_its_behalf(
    session_factory,
) -> None:
    """A lapsed lease is exactly the case a pull must not paper over.

    The session still holds the room — that is why the room is not handed
    elsewhere — but the host that would run the delivery is not answering, and
    telling whatever is asking that the work is available would hand it to a
    caller with no session behind it.
    """
    service, first = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)
    await _lapse_lease(session_factory, FIRST[0])

    with pytest.raises(SessionError) as gone:
        await service.session_room_reservations(AGENT, *FIRST, first)
    assert gone.value.code == "HOST_OFFLINE"


@pytest.mark.asyncio
async def test_a_pull_carries_the_oldest_delivery_of_each_room_longest_waiting_first(
    session_factory,
) -> None:
    """Bounded by the rooms, and ordered so no room can be crowded out.

    Only the oldest delivery of a room can be submitted next, so offering the
    ones behind it would be offering work that cannot be done. Rooms come in
    the order they have been waiting, which is what keeps a busy room from
    filling every answer while a quiet one is never mentioned.
    """
    service, first = await setup(session_factory)
    await _add_room(session_factory, SPARE)
    buffer = EventBuffer()
    positions = {
        (ROOM, "one"): buffer.enqueue(AGENT, ROOM, _event(ROOM, "one")),
        (SPARE, "two"): buffer.enqueue(AGENT, SPARE, _event(SPARE, "two")),
        (ROOM, "three"): buffer.enqueue(AGENT, ROOM, _event(ROOM, "three")),
        (SPARE, "four"): buffer.enqueue(AGENT, SPARE, _event(SPARE, "four")),
    }
    for (room_id, message_id), sequence in positions.items():
        await service.admit_room(AGENT, room_id, message_id, sequence, False, buffer)
    await _holds(session_factory, FIRST[0], [ROOM, SPARE])
    await _promised_at(session_factory, SPARE, "two", minutes_ago=4)
    await _promised_at(session_factory, ROOM, "one", minutes_ago=3)
    await _promised_at(session_factory, SPARE, "four", minutes_ago=2)
    await _promised_at(session_factory, ROOM, "three", minutes_ago=1)

    held = await service.session_room_reservations(AGENT, *FIRST, first)
    assert [(r.room_id, r.message_id) for r in held] == [
        (SPARE, "two"),
        (ROOM, "one"),
    ]


@pytest.mark.asyncio
async def test_a_later_delivery_waits_for_the_one_before_it_whatever_its_position_says(
    session_factory,
) -> None:
    """The order a restart would otherwise reverse.

    `first` was promised while the server was running the stream it is
    numbered in; the server restarted, the numbering began again, and `second`
    arrived carrying a lower position than the delivery it came after. Sorting
    on the position hands the room its messages backwards. The refusal leaves
    the later one owed, so the worker can find the earlier one and come back.
    """
    service, epoch = await setup(session_factory)
    before = EventBuffer()
    before.enqueue(AGENT, ROOM, _event(ROOM, "filler"))
    earlier = before.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", earlier, False, before)
    await _promised_at(session_factory, ROOM, "first", minutes_ago=1)

    after = EventBuffer()
    later = after.enqueue(AGENT, ROOM, _event(ROOM, "second"))
    assert later < earlier
    await service.admit_room(AGENT, ROOM, "second", later, False, after)

    with pytest.raises(SessionError) as refused:
        await service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "second", later, False, after
        )
    assert refused.value.code == "ROOM_MESSAGE_OUT_OF_ORDER"
    assert "first" in str(refused.value)

    held = await service.session_room_reservations(AGENT, *FIRST, epoch)
    assert [r.message_id for r in held] == ["first"]

    made = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "first", earlier, False, EventBuffer()
    )
    assert made.status == "accepted"
    behind = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "second", later, False, EventBuffer()
    )
    assert behind.status == "accepted"
    accepted = await service.pending(AGENT, *FIRST, epoch)
    assert [c.origin.message_id for c in accepted] == ["first", "second"]


@pytest.mark.asyncio
async def test_deliveries_made_in_the_rooms_own_order_are_never_held_back(
    session_factory,
) -> None:
    """The same two deliveries the other way round: nothing to refuse.

    The fence is about the order the room is answered in, not about making a
    worker ask twice, so a caller already submitting oldest-first never sees
    it.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    earlier = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    later = buffer.enqueue(AGENT, ROOM, _event(ROOM, "second"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", earlier, False, buffer)
    await service.admit_room(AGENT, ROOM, "second", later, False, buffer)

    for message_id, sequence in (("first", earlier), ("second", later)):
        receipt = await service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, message_id, sequence, False, buffer
        )
        assert receipt.status == "accepted"
    assert await service.session_room_reservations(AGENT, *FIRST, epoch) == []


@pytest.mark.asyncio
async def test_two_deliveries_submitted_at_once_are_settled_in_the_rooms_order(
    session_factory,
) -> None:
    """A worker that pulled a backlog and submitted it all at once.

    Serialising the two is not enough on its own: whichever reaches the lock
    first would otherwise be the one that runs. Only the earlier delivery is
    accepted, and the later one comes back as owed rather than as lost.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    earlier = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    later = buffer.enqueue(AGENT, ROOM, _event(ROOM, "second"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", earlier, False, buffer)
    await service.admit_room(AGENT, ROOM, "second", later, False, buffer)

    outcomes = await asyncio.gather(
        service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "second", later, False, buffer
        ),
        service.submit_room_message(
            AGENT, *FIRST, epoch, ROOM, "first", earlier, False, buffer
        ),
        return_exceptions=True,
    )
    assert isinstance(outcomes[0], SessionError)
    assert outcomes[0].code == "ROOM_MESSAGE_OUT_OF_ORDER"
    assert outcomes[1].status == "accepted"

    retried = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "second", later, False, buffer
    )
    assert retried.status == "accepted"


@pytest.mark.asyncio
async def test_a_delivery_the_server_has_stopped_promising_holds_nothing_back(
    session_factory,
) -> None:
    """Otherwise a delivery nobody ever comes for shuts the room.

    The earlier promise has run out. It is kept, because the controller may
    still be holding the event and about to ask for it, but it has stopped
    being something the room is waiting on.
    """
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    earlier = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    later = buffer.enqueue(AGENT, ROOM, _event(ROOM, "second"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", earlier, False, buffer)
    await service.admit_room(AGENT, ROOM, "second", later, False, buffer)
    await _promise_run_out(session_factory, ROOM, "first")

    receipt = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "second", later, False, buffer
    )
    assert receipt.status == "accepted"
    held = await service.session_room_reservations(AGENT, *FIRST, epoch)
    assert [(r.message_id, r.expired) for r in held] == [("first", True)]


@pytest.mark.asyncio
async def test_a_given_up_delivery_stops_holding_the_room_as_well(
    session_factory,
) -> None:
    """A controller that gave a delivery up has said the room may move on."""
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    earlier = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    later = buffer.enqueue(AGENT, ROOM, _event(ROOM, "second"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", earlier, False, buffer)
    await service.admit_room(AGENT, ROOM, "second", later, False, buffer)
    await service.discard_room_reservation(AGENT, ROOM, "first")

    receipt = await service.submit_room_message(
        AGENT, *FIRST, epoch, ROOM, "second", later, False, buffer
    )
    assert receipt.status == "accepted"


@pytest.mark.asyncio
async def test_the_pull_route_belongs_to_the_agent_that_owns_the_session(
    session_factory,
) -> None:
    """The HTTP door: the agent comes from the token, the host from the body."""
    service, epoch = await setup(session_factory)
    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event(ROOM, "first"))
    await service.bind_room(AGENT, *FIRST, epoch, ROOM)
    await service.admit_room(AGENT, ROOM, "first", sequence, False, buffer)

    app = FastAPI()
    app.include_router(host_router, prefix="/host")
    app.add_exception_handler(SessionError, session_error_response)

    async def refresh(session_id):
        return None

    app.dependency_overrides[host_factory] = lambda: session_factory
    app.dependency_overrides[host_lifecycle] = lambda: SimpleNamespace(
        refresh_sdk_session=refresh
    )
    app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="other-agent")
    body = {"host_id": FIRST[1], "epoch": epoch}
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        forged = await client.post(
            f"/host/sessions/{FIRST[0]}/room-reservations", json=body
        )
        assert forged.status_code == 403

        app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id=AGENT)
        held = await client.post(
            f"/host/sessions/{FIRST[0]}/room-reservations", json=body
        )
        assert held.status_code == 200
        assert held.json() == [
            {
                "room_id": ROOM,
                "message_id": "first",
                "sequence": sequence,
                "expired": False,
            }
        ]
