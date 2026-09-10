import base64
import hashlib
import uuid

import httpx
import pytest
from fastapi import FastAPI

from switch_core.bridges.agent.api.session_routes import router as host_router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_session_factory as host_factory
from switch_core.db.models import Agent, User
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_session_factory
from switch_core.gateway.sessions import router
from switch_core.sessions.http import session_error_response
from switch_core.sessions.service import SessionError

from .test_authority import command, host_event, setup


async def test_attachment_upload_download_authorization_and_idempotency(
    session_factory,
):
    authority, epoch = await setup(session_factory)
    app = FastAPI()
    app.include_router(router, prefix="/sessions")
    app.include_router(host_router, prefix="/host")
    app.add_exception_handler(SessionError, session_error_response)
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[host_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: User(id="owner")
    app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="agent-demo")
    attachment_id = str(uuid.uuid4())
    url = f"/sessions/session-demo/attachments/{attachment_id}"
    data = b"Actual file contents"
    payload = {
        "name": "example.txt",
        "mimeType": "text/plain",
        "data": base64.b64encode(data).decode(),
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.put(url, json=payload)
        assert response.status_code == 200
        attachment = response.json()
        assert (await client.put(url, json=payload)).json() == attachment
        assert (
            await client.put(url, json={**payload, "name": "changed.txt"})
        ).status_code == 409
        app.dependency_overrides[get_current_user] = lambda: User(id="viewer")
        assert (await client.put(url, json=payload)).status_code == 403
        download = f"/host{url}?host_id=host-demo&epoch={epoch}"
        response = await client.get(download)
        assert response.status_code == 200
        assert response.content == data
        assert response.headers["x-content-sha256"] == hashlib.sha256(data).hexdigest()
        app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="wrong-agent")
        assert (await client.get(download)).status_code == 403
        app.dependency_overrides[get_agent_from_scope] = lambda: Agent(id="agent-demo")
        assert (
            await client.get(download.replace("host-demo", "other-host"))
        ).status_code == 403
        assert (await client.get(download.replace(epoch, "stale"))).status_code == 409
    snapshot = await authority.snapshot("session-demo", "owner")
    session = snapshot.session.model_dump(by_alias=True)
    session["status"] = "ready"
    session["capabilities"]["attachmentMimeTypes"] = ["text/plain"]
    await authority.ingest(
        "agent-demo",
        "host-demo",
        host_event(epoch, 1, {"type": "session.upsert", "session": session}),
    )
    body = {
        "type": "message.send",
        "text": "Read this",
        "delivery": "queue",
        "attachments": [attachment],
    }
    for field, value in (
        ("bytes", 999),
        ("name", "forged.txt"),
        ("attachmentId", str(uuid.uuid4())),
    ):
        forged = {**body, "attachments": [{**attachment, field: value}]}
        with pytest.raises(SessionError):
            await authority.submit(
                command(epoch, "invalid", forged), user_id="owner", bridge_id=None
            )
    assert (
        await authority.submit(
            command(epoch, "valid", body), user_id="owner", bridge_id=None
        )
    ).status == "accepted"


@pytest.mark.parametrize(
    "name,mime,data",
    [
        ("../file", "text/plain", b"text"),
        ("dir\\file", "text/plain", b"text"),
        ("line\nname", "text/plain", b"text"),
        ("CON.txt", "text/plain", b"text"),
        ("empty.txt", "text/plain", b""),
        ("fake.png", "image/png", b"not an image"),
        ("bad.txt", "text/plain", b"\xff"),
        ("file", "application/unsupported", b"text"),
        ("large", "application/octet-stream", b"x" * (10 * 1024 * 1024 + 1)),
    ],
)
async def test_attachment_validation(session_factory, name, mime, data):
    authority, _ = await setup(session_factory)
    with pytest.raises(SessionError):
        await authority.upload_attachment(
            "session-demo", "owner", str(uuid.uuid4()), name, mime, data
        )
