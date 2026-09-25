import asyncio
import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, text

from switch_core.crypto import decrypt_token, encrypt_token
from switch_core.db.models import (
    GitHubIssuedToken,
    HostedLaunch,
    ProviderConnection,
    User,
    require_tenant_id,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.github_connections import router
from switch_core.providers.github import GitHubConnections, GitHubError
from switch_core.tenant_context import tenant_scope


@pytest.fixture
async def github_app(tmp_path, session_factory):
    config = tmp_path / "github.json"
    config.write_text(
        json.dumps(
            {
                "client_id": "example-client",
                "client_secret": "SYNTHETIC-PLACEHOLDER",
                "slug": "example-app",
                "origin": "https://switch.example.com",
            }
        )
    )
    github = GitHubConnections(str(config))
    github.exchange = AsyncMock(
        return_value={
            "access_token": "SYNTHETIC-ACCESS",
            "refresh_token": "SYNTHETIC-REFRESH",
            "expires_at": time.time() + 3600,
            "refresh_expires_at": time.time() + 7200,
        }
    )
    github.revoke = AsyncMock()
    github.request = AsyncMock(return_value={"id": 123, "login": "example-user"})
    github.repositories = AsyncMock(
        return_value=[
            {
                "id": 456,
                "account": "example-user",
                "repositories": [
                    {
                        "id": 789,
                        "name": "example/project",
                        "permissions": {"push": True},
                    }
                ],
            }
        ]
    )
    async with session_factory() as session:
        user = User(
            id="github-user",
            name="User",
            email="github@example.com",
            role="user",
            password_hash="unused",
        )
        session.add(user)
        await session.commit()
    identity = {"user": user}

    async def sessions():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.state.github_connections = github
    app.include_router(router, prefix="/gateway")
    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(
        jwt_secret_key="SYNTHETIC-ENCRYPTION-KEY"
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, github, identity, session_factory


BASE = "/gateway/provider-connections/github"
SECRET = "b" * 43


async def authorize(client):
    state = secrets.token_urlsafe(32)
    response = await client.post(
        BASE + "/flows",
        json={"port": 12345, "state": state, "completion_secret": SECRET},
    )
    assert response.status_code == 200
    started = response.json()
    response = await client.get(started["url"])
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query["state"] == [state]
    assert query["code_challenge_method"] == ["S256"]
    assert "HttpOnly" in response.headers["set-cookie"]
    return state


async def relay(client, flow_id):
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 200
    assert "Linking GitHub" in response.text
    assert (
        "form-action 'self' http://127.0.0.1:12345"
        in response.headers["content-security-policy"]
    )
    response = await client.post(
        BASE + "/callback", data={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 303
    location = urlsplit(response.headers["location"])
    assert (location.hostname, location.port, location.path) == (
        "127.0.0.1",
        12345,
        "/switch-github/callback",
    )
    assert parse_qs(location.query)["state"] == [flow_id]


async def complete(client, flow_id):
    return await client.post(
        BASE + f"/flows/{flow_id}/complete",
        json={"code": "SYNTHETIC-CODE", "completion_secret": SECRET},
    )


async def confirm(client, flow_id):
    return await client.post(
        BASE + f"/flows/{flow_id}/confirm", json={"completion_secret": SECRET}
    )


async def test_browser_handoff_requires_console_completion_and_saves_encrypted(
    github_app,
):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    github.exchange.assert_not_called()
    assert (await client.get(BASE + f"/flows/{flow_id}")).json()["status"] == "pending"
    assert (await confirm(client, flow_id)).status_code == 409
    assert (await complete(client, flow_id)).status_code == 204
    assert (await client.get(BASE)).json()["status"] == "not_connected"
    assert (await client.get(BASE + f"/flows/{flow_id}")).json() == {
        "status": "ready",
        "login": "example-user",
    }
    assert (await confirm(client, flow_id)).status_code == 200
    status = await client.get(BASE)
    assert (
        status.json()["installations"][0]["repositories"][0]["name"]
        == "example/project"
    )
    assert "SYNTHETIC-ACCESS" not in status.text
    async with factory() as session:
        row = await session.scalar(
            select(ProviderConnection).where(ProviderConnection.provider == "github")
        )
        assert "SYNTHETIC-ACCESS" not in row.encrypted_credential
        assert (
            json.loads(
                decrypt_token(row.encrypted_credential, "SYNTHETIC-ENCRYPTION-KEY")
            )["access_token"]
            == "SYNTHETIC-ACCESS"
        )
    assert (await confirm(client, flow_id)).status_code == 410
    assert (await client.delete(BASE)).status_code == 200
    github.revoke.assert_awaited_once_with("SYNTHETIC-ACCESS")
    assert (await client.get(BASE)).json()["status"] == "not_connected"


async def test_callback_rejects_missing_cookie_and_replayed_completion(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    cookies = dict(client.cookies)
    client.cookies.clear()
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 400
    github.exchange.assert_not_called()
    client.cookies.update(cookies)
    await relay(client, flow_id)
    wrong = await client.post(
        BASE + f"/flows/{flow_id}/complete",
        json={"code": "SYNTHETIC-CODE", "completion_secret": "x" * 43},
    )
    assert wrong.status_code == 400
    github.exchange.assert_not_called()
    assert (await complete(client, flow_id)).status_code == 204
    assert (await complete(client, flow_id)).status_code == 400
    assert github.exchange.await_count == 1
    assert (
        await client.get(BASE + "/authorize", params={"state": flow_id})
    ).status_code == 400


async def test_flow_is_bound_to_initiating_user_and_tenant(github_app):
    client, github, identity, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    identity["user"] = SimpleNamespace(id="different-user")
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 404
    assert (await complete(client, flow_id)).status_code == 404
    identity["user"] = SimpleNamespace(id="github-user")
    with tenant_scope("other-tenant"):
        assert (await complete(client, flow_id)).status_code == 404
    github.exchange.assert_not_called()


async def test_cancel_expiry_and_restart_are_visible(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    assert (await client.delete(BASE + f"/flows/{flow_id}")).status_code == 204
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410
    flow_id = await authorize(client)
    github.flows[flow_id].expires_at = 0
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410
    flow_id = await authorize(client)
    github.flows.clear()
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410


async def test_refresh_saved_before_repository_failure(github_app):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    github.exchange.return_value["expires_at"] = 0
    await relay(client, flow_id)
    await complete(client, flow_id)
    await confirm(client, flow_id)
    github.exchange.return_value = {
        "access_token": "NEW-SYNTHETIC-ACCESS",
        "refresh_token": "NEW-SYNTHETIC-REFRESH",
        "expires_at": time.time() + 3600,
        "refresh_expires_at": time.time() + 7200,
    }
    github.repositories.side_effect = GitHubError("Access unavailable")
    assert (await client.get(BASE)).status_code == 502
    async with factory() as session:
        row = await session.scalar(
            select(ProviderConnection).where(ProviderConnection.provider == "github")
        )
        saved = json.loads(
            decrypt_token(row.encrypted_credential, "SYNTHETIC-ENCRYPTION-KEY")
        )
        assert saved["refresh_token"] == "NEW-SYNTHETIC-REFRESH"


async def test_failed_authorization_preserves_saved_connection(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    await complete(client, flow_id)
    await confirm(client, flow_id)
    next_id = await authorize(client)
    await relay(client, next_id)
    github.exchange.side_effect = GitHubError("GitHub rejected authorization")
    assert (await complete(client, next_id)).status_code == 400
    assert (await client.get(BASE)).json()["login"] == "example-user"


@pytest.mark.parametrize(
    "change",
    [
        {"port": 80},
        {"port": 65536},
        {"port": True},
        {"host": "evil.example.test"},
        {"path": "/other"},
    ],
)
async def test_loopback_destination_cannot_be_changed(github_app, change):
    client, _, _, _ = github_app
    response = await client.post(
        BASE + "/flows",
        json={"port": 12345, "state": "a" * 43, "completion_secret": SECRET, **change},
    )
    assert response.status_code == 422


async def test_github_identity_cannot_link_to_another_workspace_user(github_app):
    client, _, identity, factory = github_app
    first = await authorize(client)
    await relay(client, first)
    assert (await complete(client, first)).status_code == 204
    assert (await confirm(client, first)).status_code == 200
    async with factory() as session:
        other = User(
            id="other-github-user",
            name="Other",
            email="other@example.com",
            role="user",
            password_hash="unused",
        )
        session.add(other)
        await session.commit()
    identity["user"] = other
    second = await authorize(client)
    await relay(client, second)
    assert (await complete(client, second)).status_code == 204
    response = await confirm(client, second)
    assert response.status_code == 409
    assert "already linked" in response.json()["detail"]
    async with factory() as session:
        rows = (await session.scalars(select(ProviderConnection))).all()
        assert len(rows) == 1
        assert rows[0].user_id == "github-user"


async def test_continue_page_reload_and_cancelled_consent(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    for _ in range(2):
        response = await client.get(
            BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
        )
        assert response.status_code == 200
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "error": "access_denied"}
    )
    assert response.status_code == 400
    assert (await client.get(BASE + f"/flows/{flow_id}")).json()["status"] == "failed"
    github.exchange.assert_not_called()


async def test_concurrent_refresh_exchanges_once_and_saves_on_cancel(github_app):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    github.exchange.return_value["expires_at"] = 0
    await relay(client, flow_id)
    await complete(client, flow_id)
    await confirm(client, flow_id)
    entered, release = asyncio.Event(), asyncio.Event()

    async def refresh(data):
        entered.set()
        await release.wait()
        return {
            "access_token": "NEW-SYNTHETIC-ACCESS",
            "refresh_token": "NEW-SYNTHETIC-REFRESH",
            "expires_at": time.time() + 3600,
            "refresh_expires_at": time.time() + 7200,
        }

    github.exchange.reset_mock()
    github.exchange.side_effect = refresh
    first = asyncio.create_task(client.get(BASE))
    await asyncio.wait_for(entered.wait(), 5)
    second = asyncio.create_task(client.get(BASE))
    deadline = asyncio.get_running_loop().time() + 5
    while True:
        async with factory() as session:
            waiting = await session.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objid::bigint = (hashtextextended(:key, 0) & 4294967295))"
                ),
                {"key": f"github-connection:{require_tenant_id()}:github-user"},
            )
        if waiting:
            break
        assert asyncio.get_running_loop().time() < deadline, (
            "Second refresh never waited for the GitHub lock"
        )
        await asyncio.sleep(0.01)
    first.cancel()
    await asyncio.sleep(0)
    first.cancel()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert (await second).status_code == 200
    github.exchange.assert_awaited_once()
    async with factory() as session:
        row = await session.scalar(
            select(ProviderConnection).where(ProviderConnection.provider == "github")
        )
        saved = json.loads(
            decrypt_token(row.encrypted_credential, "SYNTHETIC-ENCRYPTION-KEY")
        )
        assert saved["refresh_token"] == "NEW-SYNTHETIC-REFRESH"


async def test_disconnect_finishes_and_warns_when_github_revoke_fails(github_app):
    client, github, _, factory = github_app
    flow = await authorize(client)
    await relay(client, flow)
    assert (await complete(client, flow)).status_code == 204
    assert (await confirm(client, flow)).status_code == 200
    github.revoke.side_effect = GitHubError("Synthetic revocation failure")
    result = await client.delete(BASE)
    assert result.status_code == 200
    assert "GitHub settings" in result.json()["warning"]
    async with factory() as session:
        assert (
            await session.scalar(
                select(ProviderConnection).where(
                    ProviderConnection.provider == "github"
                )
            )
            is None
        )


@pytest.mark.parametrize("status", [204, 404, 422])
async def test_oauth_revocation_deletes_only_the_selected_token(
    github_app, monkeypatch, status
):
    _, github, _, _ = github_app
    request = AsyncMock(return_value=httpx.Response(status))
    monkeypatch.setattr(httpx.AsyncClient, "request", request)
    await GitHubConnections.revoke(github, "SYNTHETIC-OLD-ACCESS")
    assert request.call_args.args == (
        "DELETE",
        "https://api.github.com/applications/example-client/token",
    )
    assert request.call_args.kwargs["json"] == {"access_token": "SYNTHETIC-OLD-ACCESS"}


async def test_relink_queues_existing_installation_tokens(github_app, monkeypatch):
    client, github, identity, factory = github_app
    first = await authorize(client)
    await relay(client, first)
    assert (await complete(client, first)).status_code == 204
    assert (await confirm(client, first)).status_code == 200
    async with factory() as session:
        launch = HostedLaunch(
            id=str(uuid4()), owner_id=identity["user"].id, name="relink-worker", spec={}
        )
        session.add(launch)
        await session.flush()
        issued = GitHubIssuedToken(
            id=str(uuid4()),
            owner_id=launch.owner_id,
            launch_id=launch.id,
            launch_revision=1,
            encrypted_token=encrypt_token(
                "SYNTHETIC-INSTALLATION", "SYNTHETIC-ENCRYPTION-KEY"
            ),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            revoke_requested=False,
            attempts=0,
        )
        session.add(issued)
        await session.commit()
    monkeypatch.setattr(
        "switch_core.gateway.github_connections.revoke_pending",
        AsyncMock(return_value=True),
    )
    github.exchange.return_value = {
        **github.exchange.return_value,
        "access_token": "SYNTHETIC-RELINKED-ACCESS",
    }
    second = await authorize(client)
    await relay(client, second)
    assert (await complete(client, second)).status_code == 204
    response = await confirm(client, second)
    assert response.status_code == 200
    assert response.json()["warning"]
    github.revoke.assert_awaited_once_with("SYNTHETIC-ACCESS")
    async with factory() as session:
        row = await session.get(GitHubIssuedToken, (require_tenant_id(), issued.id))
        assert row.revoke_requested
