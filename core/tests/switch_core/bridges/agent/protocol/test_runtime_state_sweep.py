"""The runtime-state sweep must not clear a live session (CHOO-1857).

The sweep exists because there is no session-close signal: a session that
crashes while `working` would leave "working on it…" stuck on the bridge
forever. So it collapses to idle any non-idle row whose session looks dead.

"Looks dead" has to be the same union every other reader takes. It was not —
it checked only the `agent_sessions` heartbeat rows, which a client on the push
transport no longer writes. So the sweep cleared the state of a perfectly live
session on every pass, and because the bridge deletes the working message on
idle and posts a fresh one on the next update, the status message was deleted
and recreated on every refresh instead of being edited in place.

That is the bug these tests hold shut. It is worth noting it was invisible from
the server's side: nothing errored, the state was simply reset by something
that believed it was tidying up.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.service import ProtocolService

AGENT = "agent-1"
ROOM = "room-1"


class _RuntimeStateStore:
    def __init__(self, rows: list[Any]) -> None:
        self.rows = rows
        self.cleared: list[tuple[str, str]] = []

    async def get_active(self, _session: Any) -> list[Any]:
        return self.rows

    async def upsert(
        self, _session: Any, agent_id: str, room_id: str, _state: str
    ) -> None:
        self.cleared.append((agent_id, room_id))


class _SessionStore:
    """No heartbeat rows at all — the situation for a migrated client."""

    async def get_live_agent_ids(
        self, _session: Any, _agent_ids: list[str], _room_id: str | None
    ) -> set[str]:
        return set()


def _service(
    registry: ConnectionRegistry, store: _RuntimeStateStore
) -> ProtocolService:
    svc = object.__new__(ProtocolService)
    svc.connections = registry
    svc.agent_runtime_state_store = store  # type: ignore[assignment]
    svc.agent_session_store = _SessionStore()  # type: ignore[assignment]
    svc.agent_store = SimpleNamespace(get=_an_agent)  # type: ignore[assignment]
    svc.room_store = SimpleNamespace(get=_a_room)  # type: ignore[assignment]
    svc.session_factory = _session_factory  # type: ignore[assignment]
    # The emit reaches Matrix and the bridge; the decision to clear is what is
    # under test, and `cleared` records it.
    svc._emit_runtime_state = _noop  # type: ignore[assignment]
    return svc


async def _an_agent(*_a: Any, **_kw: Any) -> Any:
    return SimpleNamespace(
        id=AGENT, name="agent", integration_profile={}, metadata_={}, owner_id=None
    )


async def _a_room(*_a: Any, **_kw: Any) -> Any:
    return SimpleNamespace(id=ROOM, matrix_room_id="!m:server", bridge_id=None)


def _session_factory() -> Any:
    class _Session:
        async def __aenter__(self) -> Any:
            return SimpleNamespace(commit=_noop)

        async def __aexit__(self, *_a: Any) -> None:
            return None

    return _Session()


async def _noop(*_a: Any, **_kw: Any) -> None:
    return None


def _connected(room: str | None) -> ConnectionRegistry:
    registry = ConnectionRegistry()
    conn = registry.open(
        agent_id=AGENT,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
    )
    if room:
        registry.claim_room(conn, room)
    return registry


def _row() -> Any:
    return SimpleNamespace(agent_id=AGENT, room_id=ROOM, state="working")


async def test_a_live_connection_in_the_room_is_left_alone() -> None:
    store = _RuntimeStateStore([_row()])

    await _service(_connected(ROOM), store).sweep_runtime_states()

    assert store.cleared == []


async def test_a_connection_in_another_room_does_not_protect_this_one() -> None:
    # Otherwise any live session would freeze every room's status message.
    store = _RuntimeStateStore([_row()])

    await _service(_connected("other-room"), store).sweep_runtime_states()

    assert store.cleared == [(AGENT, ROOM)]


async def test_with_nothing_live_the_sweep_still_clears() -> None:
    """The sweep's whole purpose: a crashed session must not stay 'working'."""
    store = _RuntimeStateStore([_row()])

    await _service(ConnectionRegistry(), store).sweep_runtime_states()

    assert store.cleared == [(AGENT, ROOM)]
