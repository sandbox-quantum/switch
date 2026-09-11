import httpx
from fastapi import FastAPI

from switch_core.bridges.agent.api.session_routes import RoomMessage
from switch_core.bridges.agent.api.session_routes import router as host_router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session_factory as host_factory
from switch_core.db.models import Agent, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.sessions import router
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionError

from .test_authority import answer, opened, setup


async def test_http_identity_is_server_supplied_and_host_is_fenced(session_factory):
    authority, epoch = await setup(session_factory)
    await opened(authority, epoch)
    app = FastAPI()
    app.include_router(router, prefix="/sessions")
    app.include_router(host_router, prefix="/host")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[host_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: User(id="owner")
    app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="wrong-agent")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        request = {
            "commandId": "answer-http",
            "epoch": epoch,
            "surface": "console",
            "roomId": "room-demo",
            "body": answer(epoch, "answer-http").body.model_dump(by_alias=True),
        }
        forged = await client.post(
            "/sessions/session-demo/commands",
            json={**request, "origin": {"actorId": "someone-else"}},
        )
        assert forged.status_code == 422
        response = await client.post("/sessions/session-demo/commands", json=request)
        assert response.status_code == 200
        assert response.json()["status"] == "accepted"
        snapshot = (await client.get("/sessions/session-demo")).json()
        assert snapshot["requests"][0]["decidedBy"]["actorId"] == "owner"
        app.dependency_overrides[get_current_user] = lambda: User(id="viewer")
        assert (await client.get("/sessions/session-demo")).status_code == 403
        response = await client.post(
            "/host/sessions/session-demo/commands",
            json={"host_id": "host-demo", "epoch": epoch},
        )
        assert response.status_code == 403


async def test_http_reconciliation_fences_an_unaccepted_command(session_factory):
    authority, epoch = await setup(session_factory)
    app = FastAPI()
    app.include_router(router, prefix="/sessions")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: User(id="viewer")
    request = {
        "commandId": "late-http",
        "epoch": epoch,
        "surface": "console",
        "roomId": None,
        "body": {"type": "session.stop"},
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        url = "/sessions/session-demo/commands"
        assert (await client.post(url + "/reconcile", json=request)).status_code == 403
        app.dependency_overrides[get_current_user] = lambda: User(id="owner")
        response = await client.post(url + "/reconcile", json=request)
        assert response.status_code == 200
        assert response.json()["code"] == "NOT_ACCEPTED"
        assert (await client.post(url, json=request)).json() == response.json()
        assert (
            await authority.pending("agent-demo", "session-demo", "host-demo", epoch)
            == []
        )


def test_room_message_accepts_an_existing_host_without_context_metadata():
    request = RoomMessage.model_validate(
        {
            "host_id": "host",
            "epoch": "epoch",
            "room_id": "room",
            "message_id": "message",
            "sequence": 1,
        }
    )
    assert request.missed_count == 0
    assert request.gap_reason is None
