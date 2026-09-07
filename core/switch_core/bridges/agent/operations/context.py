"""Who is calling an operation, and what they are bound to.

Operations take their arguments and nothing else. Everything about the caller —
which agent, which connection or session, and therefore which room — is
resolved here, so an operation's signature carries no transport types and the
same function serves both front doors.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from switch_core.bridges.agent.operations.callctx import current_call_context

if TYPE_CHECKING:
    from switch_core.bridges.agent.protocol.service import ProtocolService

logger = logging.getLogger(__name__)

_NOT_CONNECTED = "Not connected to a room. Call connect_to_room first."

_protocol: ProtocolService | None = None


def init_operations_protocol(protocol: ProtocolService) -> None:
    global _protocol
    _protocol = protocol


def get_protocol() -> ProtocolService:
    assert _protocol is not None, "operations protocol not initialized"
    return _protocol


def get_agent_id() -> str:
    """The agent this call is being made on behalf of.

    Every front door binds a call context before dispatching, so operations
    never reach into a transport to find out who is calling.
    """
    bound = current_call_context()
    if bound is None:
        raise ValueError(
            "No call context bound — the front door must establish the caller "
            "before dispatching an operation"
        )
    return bound.agent_id


def session_key() -> str | None:
    """The thing that owns this caller's room binding.

    A connection id, or an MCP transport session — operations only ever compare
    it for equality, so which one it is does not matter above this line. None
    when the caller is bound to nothing, which the operations that need a room
    report as "not connected".
    """
    bound = current_call_context()
    return bound.session_key if bound is not None else None


def _resolve_room(covered: frozenset[str], room_id: str | None) -> str:
    """Pick the room an operation acts on, from what the caller actually holds.

    A room id supplied by a caller is an argument, not a permission: it is
    checked against the caller's own rooms so that naming a room is never a way
    into one. Omitted, it is only unambiguous while the caller holds one room —
    and with several, choosing silently is how an answer meant for a private
    chat ends up in a channel, so the ambiguity is raised instead.
    """
    if room_id is not None:
        if room_id not in covered:
            raise ValueError(
                f"Not connected to room {room_id}. This caller covers "
                f"{sorted(covered)} — call connect_to_room first."
            )
        return room_id
    if not covered:
        raise ValueError(_NOT_CONNECTED)
    if len(covered) > 1:
        raise ValueError(
            "This connection covers several rooms; the operation needs one — "
            f"pass room_id explicitly. Rooms covered: {sorted(covered)}."
        )
    return next(iter(covered))


async def _covered_rooms() -> frozenset[str]:
    """Every room this caller holds, or the error that it holds none.

    The live connection is asked first: a connection that has claimed a room is
    in it, whether or not anything was ever written to a table. The table is
    consulted only for callers that predate connections (an MCP transport
    session), and goes away with them.

    Shared by both requirements below so they cannot disagree about what being
    connected means — the property the split between them rests on.
    """
    key = session_key()
    if not key:
        raise ValueError(_NOT_CONNECTED)

    protocol = get_protocol()
    connection = protocol.connections.get(key)
    if connection is not None and connection.rooms:
        return frozenset(connection.rooms)

    async with protocol.session_factory() as db:
        result = await protocol.agent_session_store.get_connected_room(db, key)
    if result is None:
        raise ValueError(_NOT_CONNECTED)
    return frozenset({result[1]})


async def require_connected() -> None:
    """Assert the caller is in a room, without deciding which one.

    For operations that act on something addressed globally — a task id, the
    caller's own role lease — and need the room only as a precondition. They
    used to call `require_connected_room` and discard the result, which was
    harmless while a caller had one room and became a wall with two: the
    ambiguity error demanded a room id for a value about to be thrown away, and
    an agent on two surfaces could take a role and not give it back.

    Deliberately not on `_resolve_room`'s path, so it cannot raise the
    ambiguity error it exists to avoid.
    """
    await _covered_rooms()


async def require_connected_room(room_id: str | None = None) -> str:
    """The room this call acts on, or a clear error saying why there is none.

    `room_id` names the room when the caller holds more than one, which is what
    a connection covering several surfaces needs to act at all. It is validated
    against the caller's rooms either way — including for a single-room caller,
    where it can only confirm the room already held.
    """
    return _resolve_room(await _covered_rooms(), room_id)
