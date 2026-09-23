from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.bridges.agent.api.activity_routes import router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session_factory
from switch_core.db.models import Agent, ApprovalRequest
from switch_core.session_activity.service import ApprovalOption, PlatformPerson
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionError

from .conftest import AGENT, make_agent

SESSION = "session-demo"


@pytest.fixture
async def client(service, session_factory):
    app = FastAPI()
    app.include_router(router)
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id=AGENT)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http


def _activity(**overrides):
    body = {
        "seq": 1,
        "type": "tool.called",
        "summary": "Ran `pytest`",
        "detail": {"tool": "bash"},
        "turn_id": "turn-1",
        "room_id": None,
        "occurred_at": "2026-09-23T12:00:00Z",
    }
    body.update(overrides)
    return body


def _approval(**overrides):
    body = {
        "request_id": "req-1",
        "question": "Run `rm -rf build`?",
        "options": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
        "room_id": None,
        "thread_id": None,
        "expires_at": None,
    }
    body.update(overrides)
    return body


async def test_activity_is_recorded_and_a_retry_is_not(client):
    first = await client.post(f"/agent-sessions/{SESSION}/activity", json=_activity())
    again = await client.post(f"/agent-sessions/{SESSION}/activity", json=_activity())
    assert (first.status_code, first.json()) == (200, {"recorded": True})
    assert (again.status_code, again.json()) == (200, {"recorded": False})


async def test_conflicting_activity_is_a_409_with_its_code(client):
    await client.post(f"/agent-sessions/{SESSION}/activity", json=_activity())
    response = await client.post(
        f"/agent-sessions/{SESSION}/activity", json=_activity(summary="changed")
    )
    assert response.status_code == 409
    assert response.json()["code"] == "ACTIVITY_CONFLICT"


@pytest.mark.parametrize(
    "overrides",
    [{"type": "tool.exploded"}, {"summary": ""}, {"seq": -1}, {"unexpected": 1}],
)
async def test_malformed_activity_is_a_422(client, overrides):
    response = await client.post(
        f"/agent-sessions/{SESSION}/activity", json=_activity(**overrides)
    )
    assert response.status_code == 422


async def test_approval_round_trip_over_http(client, service, people):
    opened = await client.post(f"/agent-sessions/{SESSION}/approvals", json=_approval())
    assert opened.status_code == 200
    assert opened.json()["state"] == "open"
    assert opened.json()["requestId"] == "req-1"

    outcomes = await client.get("/agent-sessions/approvals/outcomes")
    assert outcomes.json() == []

    await service.answer_approval(
        AGENT, SESSION, "req-1", answer="allow", answerer=PlatformPerson(people.owner)
    )
    [owed] = (await client.get("/agent-sessions/approvals/outcomes")).json()
    assert (owed["state"], owed["answer"], owed["answeredBy"]) == (
        "answered",
        "allow",
        people.owner,
    )

    delivered = await client.post(
        f"/agent-sessions/{SESSION}/approvals/req-1/delivered"
    )
    assert delivered.status_code == 200
    assert delivered.json()["deliveredAt"] is not None
    assert (await client.get("/agent-sessions/approvals/outcomes")).json() == []


async def test_closing_an_open_request(client):
    await client.post(f"/agent-sessions/{SESSION}/approvals", json=_approval())
    closed = await client.post(f"/agent-sessions/{SESSION}/approvals/req-1/close")
    assert closed.json()["state"] == "closed"


async def test_delivering_an_open_request_is_refused(client):
    await client.post(f"/agent-sessions/{SESSION}/approvals", json=_approval())
    response = await client.post(f"/agent-sessions/{SESSION}/approvals/req-1/delivered")
    assert response.status_code == 409
    assert response.json()["code"] == "REQUEST_OPEN"


async def test_an_unknown_request_is_a_404(client):
    response = await client.post(f"/agent-sessions/{SESSION}/approvals/nope/close")
    assert response.status_code == 404


async def test_a_request_expiring_too_late_is_a_422(client):
    too_late = (datetime.now(UTC) + timedelta(hours=25)).isoformat()
    response = await client.post(
        f"/agent-sessions/{SESSION}/approvals", json=_approval(expires_at=too_late)
    )
    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_EVENT"


async def test_a_host_only_sees_its_own_agents_requests(
    client, service, session_factory
):
    async with session_factory() as db, db.begin():
        await make_agent(db, "other-agent")
    await service.open_approval(
        "other-agent",
        SESSION,
        request_id="theirs",
        question="Theirs?",
        options=[ApprovalOption("ok", "OK")],
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    response = await client.post(f"/agent-sessions/{SESSION}/approvals/theirs/close")
    assert response.status_code == 404
    async with session_factory() as db:
        state = await db.scalar(
            select(ApprovalRequest.state).where(ApprovalRequest.request_id == "theirs")
        )
    assert state == "open"
