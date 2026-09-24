"""Who the role lease records as its holder.

The store decides a seat is free when its named SDK session stops renewing its
host lease, and falls back to the connection only for a lease that named no
session. That fallback is what an always-on controller connection defeats: the
connection outlives every session on it, so a seat recorded against it is never
freed. Which arm applies is decided here, by the one expression that passes the
caller's session id down — so it is proven here rather than inferred from the
store tests, which supply the id themselves.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.agent.operations.callctx import (
    CallContext,
    CallerSession,
    call_context,
)
from switch_core.bridges.agent.operations.context import init_operations_protocol
from switch_core.bridges.agent.operations.definitions import assume_role
from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)

AGENT = "agent-1"
CONNECTION = "connection-1"
ROOM = "room-a"


@pytest.fixture
def holders():
    """The arguments `assume_room_role` was called with."""
    recorded: list[tuple[Any, ...]] = []

    @asynccontextmanager
    async def session_factory():
        yield SimpleNamespace()

    registry = ConnectionRegistry()
    connection = registry.open(
        agent_id=AGENT,
        connection_id=CONNECTION,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(connection, ROOM)

    async def assume_room_role(*args: Any) -> dict[str, str]:
        recorded.append(args)
        return {"role": args[2], "instructions": "lead"}

    init_operations_protocol(
        SimpleNamespace(
            connections=registry,
            session_factory=session_factory,
            assume_room_role=assume_room_role,
        )
    )
    yield recorded
    init_operations_protocol(None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_a_session_takes_the_seat_in_its_own_name(holders) -> None:
    """So the seat is freed by that session stopping, not by its connection.

    A supervised session shares its connection with its siblings and does not
    renew the lease itself, so naming the connection here would leave a dead
    worker holding an exclusive role for as long as any sibling kept the
    connection up.
    """
    context = CallContext(
        agent_id=AGENT,
        session_key=CONNECTION,
        session=CallerSession(
            id="session-a", host_id="host-1", epoch="epoch-1", room_id=ROOM
        ),
    )
    with call_context(context):
        await assume_role(role="manager")

    assert holders == [(AGENT, ROOM, "manager", CONNECTION, "session-a")]


@pytest.mark.asyncio
async def test_a_caller_that_names_no_session_still_takes_it_by_connection(
    holders,
) -> None:
    """The standalone runtime, which has no session to name and never will."""
    with call_context(
        CallContext(agent_id=AGENT, session_key=CONNECTION, session=None)
    ):
        await assume_role(role="manager")

    assert holders == [(AGENT, ROOM, "manager", CONNECTION, None)]
