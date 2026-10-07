import asyncio
import json
import secrets
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, text

from switch_core.db.models import (
    ProviderConnection,
    User,
    require_tenant_id,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.github_connections import page, router
from switch_core.keys import Keyring
from switch_core.providers.github import (
    GitHubAuthorizationError,
    GitHubConnections,
    GitHubError,
)
from switch_core.tenant_context import tenant_scope

KEY = Keyring.parse("test:" + "synthetic-encryption-test-key" * 2, legacy_secret=None)


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
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(keyring=KEY)
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
            json.loads(KEY.decrypt(row.encrypted_credential))["access_token"]
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
        saved = json.loads(KEY.decrypt(row.encrypted_credential))
        assert saved["refresh_token"] == "NEW-SYNTHETIC-REFRESH"


async def test_expired_refresh_reports_reconnect_required(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    github.exchange.return_value["expires_at"] = 0
    github.exchange.return_value["refresh_expires_at"] = 0
    await relay(client, flow_id)
    await complete(client, flow_id)
    await confirm(client, flow_id)
    response = await client.get(BASE)
    assert response.status_code == 422
    assert response.json() == {
        "detail": "GitHub authorization expired. Reconnect GitHub.",
        "code": "github_reconnect_required",
    }


async def test_revoked_access_reports_reconnect_required(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    await complete(client, flow_id)
    await confirm(client, flow_id)
    github.repositories.side_effect = GitHubAuthorizationError(
        "GitHub access expired or was revoked. Connect GitHub again."
    )
    response = await client.get(BASE)
    assert response.status_code == 422
    assert response.json() == {
        "detail": "GitHub access expired or was revoked. Connect GitHub again.",
        "code": "github_reconnect_required",
    }


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
        saved = json.loads(KEY.decrypt(row.encrypted_credential))
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


async def test_relink_revokes_the_previous_access_token(github_app):
    client, github, _, _ = github_app
    first = await authorize(client)
    await relay(client, first)
    assert (await complete(client, first)).status_code == 204
    assert (await confirm(client, first)).status_code == 200
    github.exchange.return_value = {
        **github.exchange.return_value,
        "access_token": "SYNTHETIC-RELINKED-ACCESS",
    }
    second = await authorize(client)
    await relay(client, second)
    assert (await complete(client, second)).status_code == 204
    response = await confirm(client, second)
    assert response.status_code == 200
    assert response.json()["warning"] is None
    github.revoke.assert_awaited_once_with("SYNTHETIC-ACCESS")


def test_result_page_is_branded_and_allows_only_inline_styles():
    response = page("Sign-in was interrupted. Start it again from Switch Console.", 400)
    policy = response.headers["content-security-policy"]
    body = response.body.decode()

    assert response.status_code == 400
    assert "default-src 'none'" in policy
    assert "style-src 'unsafe-inline'" in policy
    assert "frame-ancestors 'none'" in policy
    assert "script-src" not in policy
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "Sign-in was interrupted. Start it again from Switch Console." in body
    assert 'class="status error"' in body
    assert "<script" not in body
