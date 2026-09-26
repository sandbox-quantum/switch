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
from switch_core.sessions.contract import Answer, QuestionsResult
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response

from .conftest import AGENT, make_agent, pick

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
        "turn_id": "turn-1",
        "item_id": "tool-1",
        "kind": "tool-activity",
        "revision": 1,
        "status": "in-progress",
        "title": "Ran `pytest`",
        "text": "12 passed",
        "command_id": None,
        "room_id": None,
        "thread_id": None,
        "message_id": None,
        "occurred_at": "2026-09-23T12:00:00Z",
    }
    body.update(overrides)
    return body


def _approval(**overrides):
    body = {
        "request_id": "req-1",
        "turn_id": "turn-1",
        "kind": "approval",
        "title": "Run `rm -rf build`?",
        "detail": None,
        "options": [
            {"id": "allow", "label": "Allow", "decision": "accept"},
            {"id": "deny", "label": "Deny", "decision": "decline"},
        ],
        "questions": [],
        "room_id": None,
        "thread_id": None,
        "expires_at": None,
    }
    body.update(overrides)
    return body


async def test_a_step_is_recorded_and_only_a_newer_revision_moves_it(client):
    url = f"/agent-sessions/{SESSION}/activity"
    first = await client.post(url, json=_activity())
    again = await client.post(url, json=_activity())
    newer = await client.post(url, json=_activity(revision=2, status="completed"))
    older = await client.post(url, json=_activity(revision=1, status="failed"))
    assert (first.status_code, first.json()) == (200, {"recorded": True})
    assert again.json() == {"recorded": False}
    assert newer.json() == {"recorded": True}
    assert older.json() == {"recorded": False}


async def test_a_status_that_is_not_the_kinds_is_a_422_with_its_code(client):
    response = await client.post(
        f"/agent-sessions/{SESSION}/activity", json=_activity(status="running")
    )
    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_EVENT"


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "tool.exploded"},
        {"revision": -1},
        {"title": "x" * 501},
        {"text": "x" * 8001},
        {"unexpected": 1},
    ],
)
async def test_malformed_activity_is_a_422(client, overrides):
    response = await client.post(
        f"/agent-sessions/{SESSION}/activity", json=_activity(**overrides)
    )
    assert response.status_code == 422


async def test_a_questions_request_over_http(client, service, people):
    opened = await client.post(
        f"/agent-sessions/{SESSION}/approvals",
        json=_approval(
            kind="questions",
            options=[],
            questions=[
                {
                    "id": "q-env",
                    "title": "Environment",
                    "prompt": "Where should it go?",
                    "options": [
                        {"id": "staging", "label": "Staging", "description": None},
                        {"id": "prod", "label": "Production", "description": "Live"},
                    ],
                    "multi_select": False,
                    "allow_custom_answer": True,
                }
            ],
        ),
    )
    assert opened.status_code == 200
    assert opened.json()["kind"] == "questions"
    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=QuestionsResult(
            kind="questions",
            answers=[
                Answer(
                    question_id="q-env",
                    selected_option_ids=["prod"],
                    custom_text=None,
                )
            ],
        ),
        answerer=PlatformPerson(people.owner),
    )
    [owed] = (await client.get("/agent-sessions/approvals/outcomes")).json()
    assert owed["kind"] == "questions"
    assert owed["answer"] is None
    assert owed["answers"] == [
        {"question_id": "q-env", "selected_option_ids": ["prod"], "custom_text": None}
    ]


async def test_approval_round_trip_over_http(client, service, people):
    opened = await client.post(f"/agent-sessions/{SESSION}/approvals", json=_approval())
    assert opened.status_code == 200
    assert opened.json()["state"] == "open"
    assert opened.json()["requestId"] == "req-1"

    outcomes = await client.get("/agent-sessions/approvals/outcomes")
    assert outcomes.json() == []

    await service.answer_approval(
        AGENT,
        SESSION,
        "req-1",
        answer=pick("allow"),
        answerer=PlatformPerson(people.owner),
    )
    [owed] = (await client.get("/agent-sessions/approvals/outcomes")).json()
    assert (owed["kind"], owed["state"], owed["answer"], owed["answeredBy"]) == (
        "approval",
        "answered",
        "allow",
        people.owner,
    )
    assert owed["answers"] is None

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
        turn_id="turn-1",
        kind="approval",
        title="Theirs?",
        detail=None,
        questions=[],
        options=[ApprovalOption("ok", "OK", "accept")],
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
