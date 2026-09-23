import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.crypto import decrypt_token
from switch_core.db.models import ProviderConnection, User
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
    github.request = AsyncMock(return_value={"id": 123, "login": "example-user"})
    github.repositories = AsyncMock(
        return_value=[
            {
                "id": 456,
                "account": "example-user",
                "repositories": [{"id": 789, "name": "example/project"}],
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


async def authorize(client):
    started = (await client.post(BASE + "/flows")).json()
    response = await client.get(started["url"])
    query = parse_qs(urlsplit(response.headers["location"]).query)
    assert query["state"] == [started["id"]]
    assert query["code_challenge_method"] == ["S256"]
    assert "HttpOnly" in response.headers["set-cookie"]
    return started["id"]


async def test_browser_handoff_requires_confirmation_and_saves_encrypted(github_app):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 200
    assert (await client.get(BASE)).json()["status"] == "not_connected"
    assert (await client.get(BASE + f"/flows/{flow_id}")).json() == {
        "status": "ready",
        "login": "example-user",
    }
    assert (await client.post(BASE + f"/flows/{flow_id}/confirm")).status_code == 204
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
    assert (await client.post(BASE + f"/flows/{flow_id}/confirm")).status_code == 410
    assert (await client.delete(BASE)).status_code == 204
    assert (await client.get(BASE)).json()["status"] == "not_connected"


async def test_callback_rejects_missing_cookie_and_replay(github_app):
    client, github, _, _ = github_app
    flow_id = (await client.post(BASE + "/flows")).json()["id"]
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 400
    github.exchange.assert_not_called()
    await client.get(BASE + "/authorize", params={"state": flow_id})
    assert (
        await client.get(
            BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
        )
    ).status_code == 200
    assert (
        await client.get(
            BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
        )
    ).status_code == 400
    assert github.exchange.await_count == 1


async def test_flow_is_bound_to_initiating_user_and_tenant(github_app):
    client, _, identity, _ = github_app
    flow_id = await authorize(client)
    identity["user"] = SimpleNamespace(id="different-user")
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 404
    identity["user"] = SimpleNamespace(id="github-user")
    with tenant_scope("other-tenant"):
        assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 404


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
    await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    await client.post(BASE + f"/flows/{flow_id}/confirm")
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
    await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    await client.post(BASE + f"/flows/{flow_id}/confirm")
    next_id = await authorize(client)
    github.exchange.side_effect = GitHubError("GitHub rejected authorization")
    response = await client.get(
        BASE + "/callback", params={"state": next_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 400
    assert (await client.get(BASE)).json()["login"] == "example-user"
