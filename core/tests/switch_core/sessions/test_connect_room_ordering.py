"""Connecting moves the record and the routing together, or not at all.

`connect_to_room` writes two things: the durable binding that says which
session of an agent is in a room, and the claim on the agent's inbound
connection that says where that room's events go. They are read by different
parties — admission reads the binding, delivery reads the claim — so a window
between them is a window in which the two disagree and nothing later notices.

The window these guard is a sibling arriving in it. Sessions of one agent share
a connection, so the rooms a caller is leaving are the caller's own but the
connection they are released from is everyone's: a release decided before a
sibling took the room, and applied after, takes the room off the connection the
sibling is now in it on. Both moves are made under the agent's slot lock, taken
before the binding's row locks and never after, so a sibling's connect is
ordered wholly before this one or wholly after it.

Real operation, real registry, real bindings in Postgres. The interleaving is
staged by suspending one caller where its durable write has committed, which is
where the two used to be able to come apart.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations import definitions
from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    CallerSession,
    call_context,
)
from switch_core.bridges.agent.operations.context import init_operations_protocol
from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.sessions.service import RoomBinding, SessionAuthority

from .test_authority import setup
from .test_shared_connection import (
    AGENT,
    FIRST,
    OTHER_ROOM,
    ROOM,
    SECOND,
    _controller,
    _second_room,
    _second_session,
)

CONNECTION = "connection-demo"

# How long the sibling is given to get through its own connect. It takes it
# when nothing is holding the slot lock — the state this file exists to rule
# out — and does not when the lock is held, so waiting it out is how the test
# reaches its assertions either way rather than deadlocking on the fix.
SIBLING_WINDOW = 2.0


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


class _NoSessionRows:
    """The binding row table, which a caller with a connection never writes."""

    async def set_connected_room(self, *_a: Any, **_kw: Any) -> None:
        raise AssertionError("a caller with a live connection wrote a binding row")


def _protocol(connections: ConnectionRegistry, session_factory: Any) -> Any:
    """Everything `connect_to_room` reads, around the two writes under test."""
    profile = {
        "connection_model": "session_addressable",
        "message_exchange": True,
        "pre_invocation_mediation": [],
        "post_invocation_mediation": [],
        "event_reporting": [],
        "task_protocol": {"can_delegate": False, "can_accept": False},
    }

    async def _room(*args: Any, **_kw: Any) -> Any:
        room_id = args[-1]
        return SimpleNamespace(
            id=room_id, name=room_id, description="test", bridge_id=None
        )

    def _returning(value: Any):
        async def _get(*_a: Any, **_kw: Any) -> Any:
            return value

        return _get

    return SimpleNamespace(
        connections=connections,
        event_buffer=EventBuffer(),
        agent_session_store=_NoSessionRows(),
        session_factory=session_factory,
        agent_store=SimpleNamespace(
            get=_returning(
                SimpleNamespace(id=AGENT, name=AGENT, integration_profile=profile)
            )
        ),
        room_store=SimpleNamespace(get=_room),
        require_room_member=_room,
        list_participants=_returning([]),
        list_room_resources=_returning(
            {
                "reference_types": {},
                "references": [],
                "documents": [],
                "packages": [],
                "linked_rooms": [],
            }
        ),
        list_room_roles=_returning([]),
    )


def _authority_pausing_after(session_id: str, bound: asyncio.Event, go: asyncio.Event):
    """The real authority, suspended where its bind has already committed.

    The point a connect used to be interruptible at: the row says this session
    has moved, and nothing has told the connection yet.
    """

    class _Authority(SessionAuthority):
        async def bind_room(
            self,
            agent_id: str,
            caller_id: str,
            host_id: str,
            epoch: str,
            room_id: str,
        ) -> RoomBinding:
            binding = await super().bind_room(
                agent_id, caller_id, host_id, epoch, room_id
            )
            if caller_id == session_id:
                bound.set()
                await go.wait()
            return binding

    return _Authority


async def _connect(session: tuple[str, str], epoch: str, room_id: str) -> None:
    with call_context(
        CallContext(
            agent_id=AGENT,
            session_key=CONNECTION,
            session=CallerSession(
                id=session[0], host_id=session[1], epoch=epoch, room_id=None
            ),
        )
    ):
        await definitions.connect_to_room(room_id, include_general_instructions=False)


@pytest.fixture
def operations():
    yield
    init_operations_protocol(None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_a_sibling_taking_the_room_mid_connect_keeps_it_routed(
    session_factory, operations, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The room a departing session releases must be the one it still holds.

    One session leaves the room for another; a sibling takes the room it left
    while it is mid-connect. Reconciling the connection after the binding has
    committed lets the departure land last and strip the room off the shared
    connection, so the server says the sibling is in it and the connection
    carrying its events no longer claims it.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    controller = _controller(connections, [ROOM])
    await service.bind_connection(AGENT, *FIRST, first, CONNECTION, connections)
    await service.bind_room(AGENT, *FIRST, first, ROOM)
    await service.bind_connection(AGENT, *SECOND, second, CONNECTION, connections)

    bound, go = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(
        definitions, "SessionAuthority", _authority_pausing_after(FIRST[0], bound, go)
    )
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol(connections, session_factory))

    leaving = asyncio.create_task(_connect(FIRST, first, OTHER_ROOM))
    await bound.wait()
    arriving = asyncio.create_task(_connect(SECOND, second, ROOM))
    await asyncio.wait({arriving}, timeout=SIBLING_WINDOW)
    go.set()
    await asyncio.gather(leaving, arriving)

    buffer = EventBuffer()
    sequence = buffer.enqueue(AGENT, ROOM, _event("first"))
    admission = await service.admit_room(AGENT, ROOM, "first", sequence, True, buffer)
    assert admission.session_id == SECOND[0]
    assert connections.claimant_of(AGENT, ROOM) is controller
    assert controller.rooms == {ROOM, OTHER_ROOM}
    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == [OTHER_ROOM]


@pytest.mark.asyncio
async def test_two_sessions_connecting_to_one_room_leave_it_claimed_once(
    session_factory, operations, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both callers want the same room, and the room they leave is their own.

    The later binder holds the room, the earlier one is out of it, and the room
    the earlier one arrived from is released — one connection, so a claim the
    loser makes and a release the loser makes are both made on the winner's
    behalf if their order is not decided.
    """
    service, first = await setup(session_factory)
    second = await _second_session(service)
    await _second_room(session_factory)
    connections = ConnectionRegistry()
    controller = _controller(connections, [OTHER_ROOM])
    await service.bind_connection(AGENT, *FIRST, first, CONNECTION, connections)
    await service.bind_room(AGENT, *FIRST, first, OTHER_ROOM)
    await service.bind_connection(AGENT, *SECOND, second, CONNECTION, connections)

    bound, go = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(
        definitions, "SessionAuthority", _authority_pausing_after(FIRST[0], bound, go)
    )
    monkeypatch.setattr(definitions, "build_room_instructions", lambda *a, **kw: "")
    init_operations_protocol(_protocol(connections, session_factory))

    first_in = asyncio.create_task(_connect(FIRST, first, ROOM))
    await bound.wait()
    second_in = asyncio.create_task(_connect(SECOND, second, ROOM))
    await asyncio.wait({second_in}, timeout=SIBLING_WINDOW)
    go.set()
    await asyncio.gather(first_in, second_in)

    assert controller.rooms == {ROOM}
    assert (await service.snapshot(SECOND[0], "owner")).session.room_ids == [ROOM]
    assert (await service.snapshot(FIRST[0], "owner")).session.room_ids == []
