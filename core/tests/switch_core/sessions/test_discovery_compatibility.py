import copy
import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from switch_core.db.models import (
    MediaBlob,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
    User,
    require_tenant_id,
)
from switch_core.db.stores.agent_store import AgentStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.sessions import router
from switch_core.sessions.contract import Session
from switch_core.sessions.errors import SessionError
from switch_core.sessions.http import session_error_response

from .test_authority import EXAMPLES, opened, setup


@pytest.mark.parametrize("provider", ["gemini", "antigravity", "future-provider"])
async def test_unknown_provider_history_remains_readable(session_factory, provider):
    authority, _ = await setup(session_factory)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        payload = copy.deepcopy(row.snapshot)
        payload["session"]["provider"] = provider
        row.snapshot = payload
    assert (await authority.list_sessions("owner"))[0].provider == provider
    assert (
        await authority.snapshot("session-demo", "owner")
    ).session.provider == provider


async def test_bad_row_is_reported_without_hiding_healthy_sessions(session_factory):
    authority, _ = await setup(session_factory)
    healthy = Session.model_validate(EXAMPLES["initialSnapshot"]["session"]).model_copy(
        update={"session_id": "healthy-session"}
    )
    await authority.acquire("agent-demo", healthy)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        row.snapshot = {"invalid": True}
    app = FastAPI()
    app.include_router(router, prefix="/sessions")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: User(id="owner")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/sessions")
        assert response.status_code == 200
        rows = {row["sessionId"]: row for row in response.json()}
        assert rows["healthy-session"]["provider"] == healthy.provider
        assert rows["session-demo"]["agentId"] == "agent-demo"
        assert "invalid stored data" in rows["session-demo"]["discoveryError"]
        response = await client.get("/sessions/session-demo")
        assert response.status_code == 409
        assert response.json()["code"] == "INCOMPATIBLE_SESSION"
        app.dependency_overrides[get_current_user] = lambda: User(id="other-owner")
        assert (await client.get("/sessions")).json() == []
        assert (await client.get("/sessions/session-demo")).status_code == 403


async def test_deleting_agent_cascades_sdk_history(session_factory):
    authority, epoch = await setup(session_factory)
    await opened(authority, epoch)
    await authority.upload_attachment(
        "session-demo", "owner", str(uuid.uuid4()), "example.txt", "text/plain", b"test"
    )
    async with session_factory() as db, db.begin():
        for model in (SdkSession, SdkSessionEvent, SdkSessionCommand, MediaBlob):
            assert await db.scalar(select(func.count()).select_from(model)) > 0
        await AgentStore().delete(db, "agent-demo")
        for model in (SdkSession, SdkSessionEvent, SdkSessionCommand, MediaBlob):
            assert await db.scalar(select(func.count()).select_from(model)) == 0


async def test_discovery_and_presence_read_metadata_without_loading_transcript(
    session_factory,
):
    from switch_core.sessions.service import _sessions_of

    authority, _ = await setup(session_factory)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        payload = copy.deepcopy(row.snapshot)
        # A future transcript shape must not break metadata-only reads.
        payload["items"] = [{"type": "future-item", "data": "x" * 100_000}]
        row.snapshot = payload
    sessions = await authority.list_sessions("owner")
    assert sessions[0].session_id == "session-demo"
    async with session_factory() as db:
        presence = await _sessions_of(db, ["agent-demo"])
        assert presence[0].state.session_id == "session-demo"
        # Metadata reads must not leave a partial ORM snapshot for later writes.
        row = await db.get(SdkSession, (require_tenant_id(), "session-demo"))
        assert row.snapshot == payload
    with pytest.raises(SessionError, match="invalid stored data"):
        await authority.snapshot("session-demo", "owner")
