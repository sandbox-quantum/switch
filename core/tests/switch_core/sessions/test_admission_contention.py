"""Agent-scoped locking holds up when an agent's sessions all work at once.

One inbound connection per agent means one controller asking about every room
of that agent, while every session of that agent reports on its own. Those two
meet on the agent's row: room admission takes it to serialize the agent's
session work, and a session writing its own row takes a key-share on it through
the foreign key underneath. The strong mode of the first conflicts with the
second, so the admission path ends up waiting on a session whose write is
queued behind the admission path — a deadlock Postgres breaks by killing one
side, which the controller sees as a 500 and retries seconds later.

The topology this ticket introduces is what makes it reachable: before it,
sessions of one agent did not share a controller and did not contend for one
agent row on every delivery.
"""

from __future__ import annotations

import asyncio

import pytest

from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import ClientRoom, Room
from switch_core.sessions.contract import HostEvent, Session
from switch_core.sessions.service import SessionAuthority

from .test_authority import EXAMPLES, setup

AGENT = "agent-demo"
SESSIONS = 8
ROUNDS = 3


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


async def _rooms(session_factory) -> list[str]:
    room_ids = [f"room-busy-{index}" for index in range(SESSIONS)]
    async with session_factory() as db, db.begin():
        for room_id in room_ids:
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
        db.add_all([ClientRoom(client_id="agent-client", room_id=r) for r in room_ids])
    return room_ids


async def _start(
    service: SessionAuthority, index: int, room_id: str
) -> tuple[str, str, str]:
    session_id, host_id = f"session-busy-{index}", f"host-busy-{index}"
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": session_id, "host_id": host_id}
    )
    snapshot = await service.acquire(AGENT, session)
    await service.bind_room(AGENT, session_id, host_id, snapshot.session.epoch, room_id)
    return session_id, host_id, snapshot.session.epoch


@pytest.mark.asyncio
async def test_an_agents_sessions_and_its_rooms_do_not_deadlock(
    session_factory,
) -> None:
    """Every delivery is answered while the sessions it belongs to are writing.

    Fails as a database error rather than an assertion when the lock modes
    cross: Postgres aborts one of the two transactions, and the call it was
    serving raises. The assertion on the answers is what makes the round trip
    worth running at all — an agent that deadlocks its way through this would
    also be one that admits nothing.
    """
    service, _ = await setup(session_factory)
    rooms = await _rooms(session_factory)
    buffer = EventBuffer()
    started = [await _start(service, index, rooms[index]) for index in range(SESSIONS)]

    async def admit(index: int, round_index: int) -> str:
        room_id = rooms[index]
        message_id = f"busy-{index}-{round_index}"
        sequence = buffer.enqueue(AGENT, room_id, _event(room_id, message_id))
        admission = await service.admit_room(
            AGENT, room_id, message_id, sequence, True, buffer
        )
        return admission.status

    async def report(index: int, round_index: int) -> None:
        session_id, host_id, epoch = started[index]
        snapshot = await service.snapshot(session_id, "owner")
        await service.ingest(
            AGENT,
            host_id,
            HostEvent(
                contract_version=1,
                event_id=f"busy-event-{index}-{round_index}",
                session_id=session_id,
                epoch=epoch,
                host_sequence=round_index + 1,
                occurred_at="2026-09-09T12:00:00Z",
                body={
                    "type": "session.upsert",
                    "session": snapshot.session.model_copy(
                        update={"status": "running"}
                    ).model_dump(by_alias=True),
                },
            ),
        )

    async def renew(index: int) -> None:
        session_id, host_id, epoch = started[index]
        await service.renew(AGENT, session_id, host_id, epoch)

    for round_index in range(ROUNDS):
        work = []
        for index in range(SESSIONS):
            work.append(admit(index, round_index))
            work.append(report(index, round_index))
            work.append(renew(index))
        answers = await asyncio.gather(*work)
        assert [a for a in answers if isinstance(a, str)] == ["owner"] * SESSIONS
