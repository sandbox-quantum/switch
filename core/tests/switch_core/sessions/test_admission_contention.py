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
from sqlalchemy import select

from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import ClientRoom, Room, SdkSession, require_tenant_id
from switch_core.sessions.contract import HostEvent, Session
from switch_core.sessions.service import SessionAuthority

from .test_authority import EXAMPLES, setup

AGENT = "agent-demo"
OWNER = "@owner:example.test"
CONNECTION = "connection-demo"
SESSIONS = 8
ROUNDS = 3


def _event(room_id: str, message_id: str) -> AgentEvent:
    return AgentEvent(
        type="message",
        room_id=room_id,
        bridge_id="bridge",
        payload=MessagePayload(
            addressed=True,
            sender=OWNER,
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
        db.add_all(
            [
                ClientRoom(client_id=client, room_id=room_id)
                for room_id in room_ids
                for client in ("agent-client", "actor-client")
            ]
        )
    return room_ids


def _controller(connections: ConnectionRegistry, rooms: list[str]) -> Connection:
    """The agent's one inbound connection, holding every room it serves."""
    connection = connections.open(
        agent_id=AGENT,
        connection_id=CONNECTION,
        scope="all",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    for room in rooms:
        connections.claim_room(connection, room)
    return connection


async def _start(
    service: SessionAuthority,
    connections: ConnectionRegistry,
    index: int,
    room_id: str,
) -> tuple[str, str, str]:
    """A session of the agent, on the shared connection, ready for a control."""
    session_id, host_id = f"session-busy-{index}", f"host-busy-{index}"
    session = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": session_id, "host_id": host_id}
    )
    epoch = (await service.acquire(AGENT, session)).session.epoch
    await service.bind_connection(
        AGENT, session_id, host_id, epoch, CONNECTION, connections
    )
    await service.bind_room(AGENT, session_id, host_id, epoch, room_id)
    snapshot = await service.snapshot(session_id, "owner")
    ready = snapshot.session.model_copy(
        update={
            "status": "ready",
            "capabilities": snapshot.session.capabilities.model_copy(
                update={"reset": True, "compact": True}
            ),
        }
    )
    await service.ingest(
        AGENT,
        host_id,
        HostEvent(
            contract_version=1,
            event_id=f"busy-ready-{index}",
            session_id=session_id,
            epoch=epoch,
            host_sequence=1,
            occurred_at="2026-09-09T12:00:00Z",
            body={"type": "session.upsert", "session": ready.model_dump(by_alias=True)},
        ),
    )
    return session_id, host_id, epoch


@pytest.mark.asyncio
async def test_an_agents_sessions_and_its_rooms_do_not_deadlock(
    session_factory,
) -> None:
    """Every call completes, and leaves the state it was supposed to leave.

    The four paths run together are the ones that take agent-scoped locks in
    different combinations: a room delivery, a session reporting its own
    progress, a lease renewal, and a room control. Crossed lock modes show up
    here as a database error rather than an assertion — Postgres aborts one of
    the two transactions and the call it was serving raises — so the assertions
    are about what was actually recorded, not about a quiet log.
    """
    service, _ = await setup(session_factory)
    rooms = await _rooms(session_factory)
    buffer = EventBuffer()
    connections = ConnectionRegistry()
    _controller(connections, rooms)
    started = [
        await _start(service, connections, index, rooms[index])
        for index in range(SESSIONS)
    ]

    async def admit(index: int, round_index: int) -> str:
        room_id = rooms[index]
        message_id = f"busy-{index}-{round_index}"
        sequence = buffer.enqueue(AGENT, room_id, _event(room_id, message_id))
        admission = await service.admit_room(
            AGENT, room_id, message_id, sequence, True, buffer
        )
        return admission.status

    async def report(index: int, round_index: int) -> int:
        session_id, host_id, epoch = started[index]
        snapshot = await service.snapshot(session_id, "owner")
        return await service.ingest(
            AGENT,
            host_id,
            HostEvent(
                contract_version=1,
                event_id=f"busy-event-{index}-{round_index}",
                session_id=session_id,
                epoch=epoch,
                host_sequence=round_index + 2,
                occurred_at="2026-09-09T12:00:00Z",
                body={
                    "type": "session.upsert",
                    "session": snapshot.session.model_dump(by_alias=True),
                },
            ),
        )

    async def renew(index: int) -> None:
        session_id, host_id, epoch = started[index]
        await service.renew(AGENT, session_id, host_id, epoch)

    async def control(index: int, round_index: int) -> str:
        receipt = await service.submit_room_control(
            AGENT,
            rooms[index],
            "reset",
            OWNER,
            f"busy-control-{index}-{round_index}",
            None,
            connections,
        )
        assert receipt is not None
        return receipt.status

    for round_index in range(ROUNDS):
        admissions, reports, controls, _ = await asyncio.gather(
            asyncio.gather(*(admit(i, round_index) for i in range(SESSIONS))),
            asyncio.gather(*(report(i, round_index) for i in range(SESSIONS))),
            asyncio.gather(*(control(i, round_index) for i in range(SESSIONS))),
            asyncio.gather(*(renew(i) for i in range(SESSIONS))),
        )
        # Every room's delivery was answered, and answered with the session
        # that holds it rather than with an unavailable or a refusal.
        assert admissions == ["owner"] * SESSIONS
        # Each session's own write landed, in its own order.
        assert reports == [round_index + 2] * SESSIONS
        assert controls == ["accepted"] * SESSIONS

    for index in range(SESSIONS):
        session_id, host_id, epoch = started[index]
        queued = await service.pending(AGENT, session_id, host_id, epoch)
        assert [command.origin.message_id for command in queued] == [
            f"busy-control-{index}-{round_index}" for round_index in range(ROUNDS)
        ]

    async with session_factory() as db:
        sequences = (
            await db.scalars(
                select(SdkSession.host_sequence)
                .where(
                    SdkSession.tenant_id == require_tenant_id(),
                    SdkSession.agent_id == AGENT,
                    SdkSession.id.like("session-busy-%"),
                )
                .order_by(SdkSession.id)
            )
        ).all()
    assert list(sequences) == [ROUNDS + 1] * SESSIONS
