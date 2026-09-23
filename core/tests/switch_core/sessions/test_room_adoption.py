"""Carrying a room across from a build that never claimed it on the server.

A session started by the build this topology replaces kept its room set on
disk and served it over a connection of its own. Nothing about that room
reached the server, so when the session is restarted by a build whose
controller holds the agent's only connection it comes up holding nothing and
the room's next message is answered by a stranger.

Adoption is the one-time carry-across, and every test here is about what it
must refuse. The room list the caller offers is read off a local disk: it says
where a session was, not that the room is still its to take. The server decides
each room against what it holds, and a room it will not give back is named in
the answer rather than dropped.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from switch_core.db.models import SdkRoomAdmission, SdkSession, require_tenant_id
from switch_core.sessions.service import RoomAdoption, SessionAuthority, SessionError

from .test_authority import setup
from .test_shared_connection import (
    AGENT,
    OTHER_ROOM,
    ROOM,
    SECOND,
    _finish_session,
    _second_room,
    _second_session,
    _stop_host,
)

FIRST_SESSION, FIRST_HOST = "session-demo", "host-demo"


async def _legacy(session_factory) -> tuple[SessionAuthority, str]:
    """An agent whose one session holds no room, as an upgraded legacy one does.

    `setup` acquires without a grant, which is exactly the shape the old build
    left behind: a session row the server knows about, with an empty room set,
    because the room it was serving lived in a file the server never saw.
    """
    service, epoch = await setup(session_factory)
    snapshot = await service.snapshot(FIRST_SESSION, "owner")
    assert snapshot.session.room_ids == []
    return service, epoch


async def _grant(session_factory, room: str, message: str) -> None:
    """Give the agent the right to start one session for a room, by hand.

    Written straight to the admission row rather than driven through
    `admit_room`, which would need a verified room event behind it. What is
    under test is the fence, and the fence reads this row.
    """
    async with session_factory() as db, db.begin():
        db.add(
            SdkRoomAdmission(
                agent_id=AGENT,
                room_id=room,
                message_id=message,
                sequence=1,
                delivery={},
                expires_at=datetime.now(UTC) + timedelta(minutes=5),
                grant_expires_at=datetime.now(UTC) + timedelta(minutes=5),
            )
        )


async def test_a_legacy_session_adopts_the_room_it_was_serving(session_factory):
    service, epoch = await _legacy(session_factory)

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption.adopted == (ROOM,)
    assert adoption.refused == ()
    # The same session, now holding the room: the identity the room was talking
    # to is the one that answers it next, which is the whole point.
    snapshot = await service.snapshot(FIRST_SESSION, "owner")
    assert snapshot.session.session_id == FIRST_SESSION
    assert snapshot.session.room_ids == [ROOM]


async def test_a_session_that_already_holds_the_room_is_unchanged(session_factory):
    """The current-to-next upgrade: the claim is durable and nothing is rewritten.

    A session of this build recovers with its rooms intact, so it offers the
    server a room the server already has it in. That has to cost nothing —
    neither a refusal, which would read as a room lost, nor an event, which
    would announce a change that did not happen.
    """
    service, epoch = await _legacy(session_factory)
    await service.adopt_rooms(AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM])
    before = await service.snapshot(FIRST_SESSION, "owner")

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption == RoomAdoption(adopted=(ROOM,), refused=())
    after = await service.snapshot(FIRST_SESSION, "owner")
    assert after.through_sequence == before.through_sequence
    assert after.session.room_ids == [ROOM]


async def test_a_room_another_session_holds_is_refused(session_factory):
    """A transfer that happened while the upgrade was in flight keeps its winner."""
    service, epoch = await _legacy(session_factory)
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption.adopted == ()
    assert [(r.room_id, r.reason) for r in adoption.refused] == [(ROOM, "ROOM_HELD")]
    # Kept by the session that holds it rather than evicted to make room.
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []


async def test_a_room_whose_claimant_lost_its_host_is_still_refused(session_factory):
    """An unfinished session whose host was killed is coming back to its room.

    It cannot be routed to, so it is not an owner — but it is a claimant, and
    handing its room to a session that never held it would take the room away
    from the one that did.
    """
    service, epoch = await _legacy(session_factory)
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    await _stop_host(session_factory, SECOND[0])

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert [(r.room_id, r.reason) for r in adoption.refused] == [(ROOM, "ROOM_HELD")]


async def test_an_outstanding_grant_refuses_the_room(session_factory):
    """The session the grant is for may not exist yet, and the room is its.

    Adopting inside that window would leave the grant to be redeemed against a
    room that had stopped being free, which is how one room ends up with two
    owners.
    """
    service, epoch = await _legacy(session_factory)
    await _grant(session_factory, ROOM, "message-granted")

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption.adopted == ()
    assert [(r.room_id, r.reason) for r in adoption.refused] == [
        (ROOM, "GRANT_OUTSTANDING")
    ]


async def test_a_spent_grant_does_not_hold_a_room_its_session_has_finished(
    session_factory,
):
    """A redeemed grant is answered for by its session, not by the row.

    Counting the spent row as a hold too would leave the room unadoptable for
    the rest of the promise, long after the session it was granted to stopped.
    """
    service, epoch = await _legacy(session_factory)
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    await _finish_session(service, SECOND[0], SECOND[1], second_epoch)
    await _grant(session_factory, ROOM, "message-spent")
    async with session_factory() as db, db.begin():
        reservation = await db.get(
            SdkRoomAdmission, (require_tenant_id(), AGENT, ROOM, "message-spent")
        )
        reservation.granted_session_id = SECOND[0]

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption.adopted == (ROOM,)


async def test_a_session_evicted_from_a_room_cannot_take_it_back(session_factory):
    """Its own history says it held the room and lost it, so `[]` is not legacy.

    The distinction the empty room set cannot make: a session that never
    claimed a room and one a sibling took it from look identical in the
    session's current state and are opposites in what should happen next.
    """
    service, epoch = await _legacy(session_factory)
    await service.adopt_rooms(AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM])
    second_epoch = await _second_session(service)
    binding = await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, ROOM)
    assert binding.displaced == FIRST_SESSION
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []
    await _finish_session(service, SECOND[0], SECOND[1], second_epoch)

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]
    )

    assert adoption.adopted == ()
    assert [(r.room_id, r.reason) for r in adoption.refused] == [
        (ROOM, "PRIOR_CLAIM_RECORDED")
    ]


async def test_a_retry_after_a_lost_response_reasserts_nothing_lost_since(
    session_factory,
):
    """The idempotency the host needs, and the limit on it.

    A controller that never saw the answer sends the same offer again. Rooms
    still held come back as adopted, because they are; a room taken in between
    is refused rather than taken back, because the first call succeeded and
    what happened after it is not this call's to undo.
    """
    service, epoch = await _legacy(session_factory)
    await _second_room(session_factory)

    first = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM, OTHER_ROOM]
    )
    assert first.adopted == (ROOM, OTHER_ROOM)
    second_epoch = await _second_session(service)
    await service.bind_room(AGENT, SECOND[0], SECOND[1], second_epoch, OTHER_ROOM)

    retry = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM, OTHER_ROOM]
    )

    assert retry.adopted == (ROOM,)
    assert [(r.room_id, r.reason) for r in retry.refused] == [
        (OTHER_ROOM, "PRIOR_CLAIM_RECORDED")
    ]
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [OTHER_ROOM]


async def test_a_room_the_agent_has_left_is_refused(session_factory):
    service, epoch = await _legacy(session_factory)

    adoption = await service.adopt_rooms(
        AGENT, FIRST_SESSION, FIRST_HOST, epoch, ["room-elsewhere"]
    )

    assert [(r.room_id, r.reason) for r in adoption.refused] == [
        ("room-elsewhere", "NOT_A_MEMBER")
    ]


async def test_another_hosts_epoch_cannot_adopt(session_factory):
    """Authenticated as the session behind the host and epoch fence, like every
    other call a host makes — a stale generation of the host does not speak for
    the session it used to run."""
    service, epoch = await _legacy(session_factory)

    with pytest.raises(SessionError) as stale:
        await service.adopt_rooms(
            AGENT, FIRST_SESSION, FIRST_HOST, "not-the-epoch", [ROOM]
        )
    with pytest.raises(SessionError) as foreign:
        await service.adopt_rooms(AGENT, FIRST_SESSION, "other-host", epoch, [ROOM])

    assert stale.value.code == "STALE_EPOCH"
    assert foreign.value.code == "NOT_AUTHORIZED"
    assert (await service.snapshot(FIRST_SESSION, "owner")).session.room_ids == []


async def test_concurrent_adoptions_of_one_room_leave_one_owner(session_factory):
    """Two sessions of one agent offering the same room at the same time.

    Both are legacy by their own history, so nothing but the lock decides
    between them. They serialize on the agent row the same way an admission and
    a bind do, and the second sees the first's claim rather than the free room
    it started from.
    """
    service, epoch = await _legacy(session_factory)
    second_epoch = await _second_session(service)

    first, second = await asyncio.gather(
        service.adopt_rooms(AGENT, FIRST_SESSION, FIRST_HOST, epoch, [ROOM]),
        service.adopt_rooms(AGENT, SECOND[0], SECOND[1], second_epoch, [ROOM]),
    )

    assert sorted([len(first.adopted), len(second.adopted)]) == [0, 1]
    assert [r.reason for r in first.refused + second.refused] == ["ROOM_HELD"]
    async with session_factory() as db:
        rows = list(
            await db.scalars(
                select(SdkSession).where(
                    SdkSession.tenant_id == require_tenant_id(),
                    SdkSession.agent_id == AGENT,
                )
            )
        )
    holders = [row.id for row in rows if ROOM in row.snapshot["session"]["roomIds"]]
    assert len(holders) == 1, holders
