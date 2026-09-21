"""A caller may name its session instead of its connection.

The operations door has only ever accepted a connection id, which is why every
operation that resolves a room implicitly resolves it from a connection — and
why a connection covering more than one room has nowhere to go. Naming the
session is the step that makes the session addressable in its own right.

Nothing changes yet. While a session owns at most one connection the session
selector is answered with that connection, so the two selectors produce the
same key and every existing caller behaves identically. This file is the proof
of that equivalence, and of the refusals that keep the selector from being a
cheaper way in than the connection it stands for.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from switch_core.bridges.agent.api.operations import (
    SESSION_SELECTOR_HEADERS,
    resolve_session_key,
    router,
)
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_protocol, get_session_factory
from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_LAPSED,
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionError
from switch_core.tenant_context import tenant_scope
from tests.switch_core.sessions.test_authority import setup

AGENT = "agent-demo"
SESSION = "session-demo"
HOST = "host-demo"
CONNECTION = "connection-demo"
ROOM = "room-demo"


class _Protocol:
    """Enough of ProtocolService for the door's connection check."""

    def __init__(self, connections: ConnectionRegistry) -> None:
        self.connections = connections


def _open(connections: ConnectionRegistry, connection_id: str):
    return connections.open(
        agent_id=AGENT,
        connection_id=connection_id,
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )


async def _bound(session_factory):
    """A session holding a live connection, the state every caller is in."""
    service, epoch = await setup(session_factory)
    connections = ConnectionRegistry()
    connections.claim_room(_open(connections, CONNECTION), ROOM)
    await service.bind_connection(AGENT, SESSION, HOST, epoch, CONNECTION, connections)
    return epoch, _Protocol(connections)


async def _resolve(
    session_factory,
    protocol: _Protocol,
    *,
    connection_id: str | None,
    session_id: str | None,
    host_id: str | None,
    epoch: str | None,
) -> str | None:
    return await resolve_session_key(
        agent_id=AGENT,
        protocol=protocol,  # type: ignore[arg-type]
        factory=session_factory,
        connection_id=connection_id,
        session_id=session_id,
        host_id=host_id,
        epoch=epoch,
    )


@pytest.mark.asyncio
async def test_both_selectors_resolve_to_the_same_key(session_factory) -> None:
    """The whole point of the expand step: one answer, two ways to ask for it.

    If these ever diverged, moving a caller from one selector to the other
    would silently move which room its operations act on.
    """
    epoch, protocol = await _bound(session_factory)

    by_connection = await _resolve(
        session_factory,
        protocol,
        connection_id=CONNECTION,
        session_id=None,
        host_id=None,
        epoch=None,
    )
    by_session = await _resolve(
        session_factory,
        protocol,
        connection_id=None,
        session_id=SESSION,
        host_id=HOST,
        epoch=epoch,
    )

    assert by_connection == by_session == CONNECTION


@pytest.mark.asyncio
async def test_naming_both_agrees_or_is_refused(session_factory) -> None:
    epoch, protocol = await _bound(session_factory)
    _open(protocol.connections, "connection-other")

    agreeing = await _resolve(
        session_factory,
        protocol,
        connection_id=CONNECTION,
        session_id=SESSION,
        host_id=HOST,
        epoch=epoch,
    )
    assert agreeing == CONNECTION

    with pytest.raises(HTTPException) as caught:
        await _resolve(
            session_factory,
            protocol,
            connection_id="connection-other",
            session_id=SESSION,
            host_id=HOST,
            epoch=epoch,
        )

    assert caught.value.status_code == 409
    assert "send one selector or the other" in caught.value.detail


@pytest.mark.asyncio
async def test_a_caller_naming_nothing_is_bound_to_nothing(session_factory) -> None:
    """Unchanged: an operation needing a room reports that it has none."""
    _, protocol = await _bound(session_factory)

    assert (
        await _resolve(
            session_factory,
            protocol,
            connection_id=None,
            session_id=None,
            host_id=None,
            epoch=None,
        )
        is None
    )


@pytest.mark.asyncio
async def test_an_incomplete_selector_is_refused(session_factory) -> None:
    """Two thirds of a fence is not a fence.

    Dropping the host or the epoch would leave a bare session id, which is
    guessable and belongs to whoever names it first.
    """
    epoch, protocol = await _bound(session_factory)

    for partial in (
        {"session_id": SESSION, "host_id": None, "epoch": None},
        {"session_id": SESSION, "host_id": HOST, "epoch": None},
        {"session_id": None, "host_id": HOST, "epoch": epoch},
    ):
        with pytest.raises(HTTPException) as caught:
            await _resolve(session_factory, protocol, connection_id=None, **partial)
        assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_the_selector_passes_the_session_fence(session_factory) -> None:
    """Named, not trusted: the same fence binding the connection had to pass."""
    epoch, protocol = await _bound(session_factory)

    with pytest.raises(SessionError) as stale:
        await _resolve(
            session_factory,
            protocol,
            connection_id=None,
            session_id=SESSION,
            host_id=HOST,
            epoch="not-this-epoch",
        )
    assert stale.value.code == "STALE_EPOCH"

    with pytest.raises(SessionError) as impostor:
        await _resolve(
            session_factory,
            protocol,
            connection_id=None,
            session_id=SESSION,
            host_id="another-host",
            epoch=epoch,
        )
    assert impostor.value.code == "NOT_AUTHORIZED"


@pytest.mark.asyncio
async def test_another_agents_session_is_refused(session_factory) -> None:
    """The authenticated agent decides, so the selector cannot cross agents."""
    epoch, protocol = await _bound(session_factory)

    with pytest.raises(SessionError) as caught:
        await resolve_session_key(
            agent_id="agent-intruder",
            protocol=protocol,  # type: ignore[arg-type]
            factory=session_factory,
            connection_id=None,
            session_id=SESSION,
            host_id=HOST,
            epoch=epoch,
        )

    assert caught.value.code == "NOT_AUTHORIZED"


@pytest.mark.asyncio
async def test_a_session_that_bound_nothing_says_so(session_factory) -> None:
    """Not "no room" — a session that never bound is a caller error, said out loud."""
    service, epoch = await setup(session_factory)
    protocol = _Protocol(ConnectionRegistry())

    with pytest.raises(SessionError) as caught:
        await _resolve(
            session_factory,
            protocol,
            connection_id=None,
            session_id=SESSION,
            host_id=HOST,
            epoch=epoch,
        )

    assert caught.value.code == "NO_ROOM_CONNECTION"
    assert await service.snapshot(SESSION, "owner") is not None


@pytest.mark.asyncio
async def test_a_dead_connection_is_refused_through_either_selector(
    session_factory,
) -> None:
    """The binding outlives the connection, and must not resurrect it.

    A session row keeps its connection id after the connection goes; the
    connection selector has always refused that, and naming the session must
    not be the way around it.
    """
    epoch, protocol = await _bound(session_factory)
    protocol.connections.close(CONNECTION, HEARTBEAT_LAPSED)

    for selector in (
        {
            "connection_id": CONNECTION,
            "session_id": None,
            "host_id": None,
            "epoch": None,
        },
        {
            "connection_id": None,
            "session_id": SESSION,
            "host_id": HOST,
            "epoch": epoch,
        },
    ):
        with pytest.raises(HTTPException) as caught:
            await _resolve(session_factory, protocol, **selector)
        assert caught.value.status_code == 409


# ── the headers the selector actually arrives on ─────────────────────────────


class _Agent:
    id = AGENT


class _TenantMiddleware:
    """Stands in for the auth middleware, which is what binds the tenant."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        with tenant_scope(TENANT_ZERO_ID):
            await self.app(scope, receive, send)


def _app(session_factory, protocol: _Protocol) -> FastAPI:
    """The real route, so the header names and the wiring are under test too.

    Everything above this point calls the resolver directly. That proves the
    rule and not the spelling — a mistyped alias or an unwired dependency would
    pass all of it and fail on the first real request.
    """
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(_TenantMiddleware)
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_agent_from_scope] = lambda: _Agent()
    app.dependency_overrides[get_protocol] = lambda: protocol
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    return app


async def _post(client: httpx.AsyncClient, headers: dict[str, str]):
    return await client.post(
        f"/agents/{AGENT}/ops/no_such_operation", json={}, headers=headers
    )


@pytest.mark.asyncio
async def test_the_selector_is_read_from_its_headers(session_factory) -> None:
    epoch, protocol = await _bound(session_factory)
    session, host, generation = SESSION_SELECTOR_HEADERS

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(session_factory, protocol)),
        base_url="http://test",
    ) as client:
        # Resolved, then dispatched: only an accepted selector gets as far as
        # the operation lookup that rejects this name.
        accepted = await _post(
            client, {session: SESSION, host: HOST, generation: epoch}
        )
        assert accepted.status_code == 404

        stale = await _post(
            client, {session: SESSION, host: HOST, generation: "not-this-epoch"}
        )
        assert stale.status_code == 409
        assert stale.json()["code"] == "STALE_EPOCH"

        partial = await _post(client, {session: SESSION})
        assert partial.status_code == 400
