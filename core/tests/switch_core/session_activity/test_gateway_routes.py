from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from switch_core.db.models import User
from switch_core.gateway.agent_sessions import router
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.session_activity.service import (
    ApprovalOption,
    Question,
    QuestionOption,
)
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response

from .conftest import make_agent

SESSION = "session-demo"


@pytest.fixture
async def owned(session_factory, service):
    """An agent with one open request, and the id of the person who owns it."""
    async with session_factory() as db, db.begin():
        owner_id = await make_agent(db, "console-agent")
    await service.open_approval(
        "console-agent",
        SESSION,
        request_id="req-1",
        turn_id="turn-1",
        kind="approval",
        title="Deploy to production?",
        detail=None,
        questions=[],
        options=[
            ApprovalOption("yes", "Yes", "accept"),
            ApprovalOption("no", "No", "decline"),
        ],
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    return owner_id


def _client(session_factory, user_id: str) -> httpx.AsyncClient:
    app = FastAPI()
    app.include_router(router, prefix="/agent-sessions")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: User(
        id=user_id, name="Someone", email=f"{user_id}@example.test", role="user"
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    )


async def test_the_owner_sees_and_answers_their_agents_request(session_factory, owned):
    async with _client(session_factory, owned) as client:
        [request] = (await client.get("/agent-sessions/approvals")).json()
        assert request["title"] == "Deploy to production?"
        assert request["kind"] == "approval"
        assert request["options"] == [
            {"id": "yes", "label": "Yes", "decision": "accept"},
            {"id": "no", "label": "No", "decision": "decline"},
        ]
        answered = await client.post(
            "/agent-sessions/console-agent/session-demo/approvals/req-1/answer",
            json={"answer": "yes"},
        )
        assert answered.status_code == 200
        assert answered.json()["state"] == "answered"
        assert answered.json()["answeredBy"] == f"user:{owned}"
        assert (await client.get("/agent-sessions/approvals")).json() == []


async def test_someone_else_neither_sees_nor_answers_it(session_factory, owned):
    async with _client(session_factory, "someone-else") as client:
        assert (await client.get("/agent-sessions/approvals")).json() == []
        refused = await client.post(
            "/agent-sessions/console-agent/session-demo/approvals/req-1/answer",
            json={"answer": "yes"},
        )
        assert refused.status_code == 403
        assert refused.json()["code"] == "NOT_AUTHORIZED"


async def test_the_owner_answers_a_questions_request(session_factory, service, owned):
    await service.open_approval(
        "console-agent",
        SESSION,
        request_id="req-2",
        turn_id="turn-1",
        kind="questions",
        title="A couple of things",
        detail=None,
        options=[],
        questions=[
            Question(
                id="q-env",
                title="Environment",
                prompt="Where should it go?",
                options=[QuestionOption("staging", "Staging", None)],
                multi_select=False,
                allow_custom_answer=True,
            )
        ],
        room_id=None,
        thread_id=None,
        expires_at=None,
    )
    async with _client(session_factory, owned) as client:
        listed = (await client.get("/agent-sessions/approvals")).json()
        [asked] = [request for request in listed if request["requestId"] == "req-2"]
        assert asked["questions"][0]["options"] == [
            {"id": "staging", "label": "Staging", "description": None}
        ]
        both = await client.post(
            "/agent-sessions/console-agent/session-demo/approvals/req-2/answer",
            json={"answer": "staging", "answers": []},
        )
        assert both.status_code == 422
        answered = await client.post(
            "/agent-sessions/console-agent/session-demo/approvals/req-2/answer",
            json={
                "answers": [
                    {
                        "questionId": "q-env",
                        "selectedOptionIds": [],
                        "customText": "canary",
                    }
                ]
            },
        )
        assert answered.status_code == 200, answered.json()
        assert answered.json()["answers"] == [
            {"questionId": "q-env", "selectedOptionIds": [], "customText": "canary"}
        ]
