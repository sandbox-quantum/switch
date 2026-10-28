"""The agent API answers a refused or malformed request with a 4xx, not a 500.

AgentCore raises PermissionError when an agent is not allowed to act on a room,
and the timestamp parser raises ValueError on a string it cannot read. A route
that lets either escape answers 500, which tells an HTTP agent the server broke
when it was the request that was wrong, so the agent may retry something that
will never succeed.

Reported in https://github.com/sandbox-quantum/switch/issues/1045.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.api import handlers, operations
from switch_core.bridges.agent.app import log_http_exceptions, log_validation_errors
from switch_core.bridges.agent.operations import context as op_context
from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.stores.message_store import MessageStore
from tests.switch_core.bridges.agent.protocol.test_room_roster_authz import (
    _make_public_room,
    _make_user,
    _register,
    _service,
)


async def _request(
    svc: AgentCore, caller_id: str, method: str, path: str, json: object = None
) -> Response:
    app = FastAPI()
    app.add_exception_handler(HTTPException, log_http_exceptions)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, log_validation_errors)  # type: ignore[arg-type]
    app.include_router(handlers.router, prefix="/agents")
    app.include_router(operations.router)
    app.dependency_overrides[handlers.get_agent_from_scope] = lambda: SimpleNamespace(
        id=caller_id
    )
    app.dependency_overrides[handlers.get_protocol] = lambda: svc
    # The ops door runs operations against the process-wide protocol.
    app.dependency_overrides[operations.get_session_factory] = lambda: None
    op_context.init_operations_protocol(svc)

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, json=json)


@dataclass
class _Room:
    svc: AgentCore
    room_id: str
    member_id: str
    outsider_id: str


async def _room_with_an_outsider(
    session_factory: async_sessionmaker[AsyncSession],
) -> _Room:
    svc = _service(session_factory)
    svc.message_store = MessageStore()  # the roster tests never read history
    owner = await _make_user(session_factory, "owner")
    other = await _make_user(session_factory, "other")
    member_id = await _register(svc, "member-agent", owner)
    outsider_id = await _register(svc, "outsider-agent", other)
    room_id = await _make_public_room(
        session_factory, owner_id=owner, member_agent_ids=[member_id]
    )
    return _Room(svc=svc, room_id=room_id, member_id=member_id, outsider_id=outsider_id)


async def test_a_refused_invite_is_403(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    r = await _room_with_an_outsider(session_factory)

    resp = await _request(
        r.svc,
        r.outsider_id,
        "POST",
        f"/agents/{r.outsider_id}/ops/invite_agent_to_room",
        json={"room_id": r.room_id, "agent_name": "outsider-agent"},
    )

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Not authorized to change this room's membership"}


async def test_a_non_member_looking_up_a_room_is_403(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    r = await _room_with_an_outsider(session_factory)

    resp = await _request(
        r.svc,
        r.outsider_id,
        "POST",
        f"/agents/{r.outsider_id}/ops/get_room_detail",
        json={"room_id": r.room_id},
    )

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Agent is not a member of this room"}


async def test_a_history_timestamp_that_does_not_parse_is_400_naming_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    r = await _room_with_an_outsider(session_factory)
    path = f"/agents/{r.member_id}/rooms/{r.room_id}/history"

    for param in ("since", "before"):
        resp = await _request(
            r.svc, r.member_id, "GET", f"{path}?{urlencode({param: 'yesterday'})}"
        )

        assert resp.status_code == 400
        assert resp.json() == {
            "detail": f"'{param}' is not an ISO 8601 timestamp: 'yesterday'"
        }


async def test_a_history_timestamp_its_offset_moves_off_the_calendar_is_400(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """It parses, but in UTC it falls in year 0 or 10000, which no query can use."""
    r = await _room_with_an_outsider(session_factory)
    path = f"/agents/{r.member_id}/rooms/{r.room_id}/history"

    for param, value in (
        ("since", "0001-01-01T00:00:00+01:00"),
        ("before", "9999-12-31T23:59:59-01:00"),
    ):
        resp = await _request(
            r.svc, r.member_id, "GET", f"{path}?{urlencode({param: value})}"
        )

        assert resp.status_code == 400
        assert resp.json() == {
            "detail": f"'{param}' is outside the years 1 to 9999 in UTC: '{value}'"
        }


async def test_history_reads_between_the_first_and_last_moments_of_the_calendar(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    r = await _room_with_an_outsider(session_factory)
    query = urlencode(
        {"since": "0001-01-01T00:00:00Z", "before": "9999-12-31T23:59:59.999999Z"}
    )

    resp = await _request(
        r.svc,
        r.member_id,
        "GET",
        f"/agents/{r.member_id}/rooms/{r.room_id}/history?{query}",
    )

    assert resp.status_code == 200
    assert resp.json() == {"events": [], "has_more": False}
