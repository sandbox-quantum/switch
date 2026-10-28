import asyncio
import json
import secrets
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select, update

from switch_core.connections.adapters.github import GitHubAdapter
from switch_core.connections.broker import ServiceBroker
from switch_core.connections.loader import CATALOG
from switch_core.connections.sign_in_flows import SignInFlows
from switch_core.db.models import (
    ServiceConnection,
    ServiceTokenIssuance,
    SignInFlow,
    User,
    require_tenant_id,
)
from switch_core.db.stores.service_connection_store import ServiceConnectionStore
from switch_core.db.stores.workspace_service_store import WorkspaceServiceStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.github_connections import router
from switch_core.keys import Keyring
from switch_core.providers.github import GitHubConnections, GitHubError, GitHubReach
from switch_core.providers.github_installation import GitHubInstallationCredentials
from switch_core.tenant_context import tenant_scope

TEST_KEYRING = Keyring.parse("test:" + "x" * 40, legacy_secret=None)


@pytest.fixture
async def github_app(request, tmp_path, session_factory):
    """The GitHub routes on their own. Parametrize indirectly with True for the
    workspace switch to apply, as the `service_connections` flag makes it."""
    workspace_gate = getattr(request, "param", False)
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
    github = GitHubConnections.from_file(str(config))
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
        return_value=GitHubReach(
            installations=[
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
            ],
            sso_hidden=[],
        )
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

    app = _process(github, identity, session_factory, workspace_gate)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, github, identity, session_factory


def _process(github, identity, session_factory, workspace_gate: bool) -> FastAPI:
    """One switch-core process's gateway: its own app, broker and flow store,
    on the shared database."""

    async def sessions():
        async with session_factory() as session:
            yield session

    app = FastAPI()
    app.state.github_connections = github
    app.state.sign_in_flows = SignInFlows(session_factory, TEST_KEYRING)
    app.state.service_broker = ServiceBroker(
        session_factory=session_factory,
        keyring=TEST_KEYRING,
        catalog=CATALOG,
        adapters={"github": GitHubAdapter(github, AsyncMock())},
        disabled={},
        store=ServiceConnectionStore(),
        token_retention=timedelta(days=30),
        workspace_services=WorkspaceServiceStore(),
        workspace_gate=workspace_gate,
        public_url=None,
    )
    app.include_router(router, prefix="/gateway")
    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(keyring=TEST_KEYRING)
    return app


class _EachRequestToTheNextProcess(httpx.AsyncBaseTransport):
    """A load balancer with no stickiness: each request goes to the next of
    the processes, in turn."""

    def __init__(self, *apps: FastAPI) -> None:
        self._transports = [httpx.ASGITransport(app=app) for app in apps]
        self._next = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        transport = self._transports[self._next % len(self._transports)]
        self._next += 1
        return await transport.handle_async_request(request)


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
    """The browser comes back from GitHub and is sent on to Console's listener."""
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
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


async def test_browser_handoff_completes_through_console_and_saves_encrypted(
    github_app,
):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    github.exchange.assert_not_called()
    assert (await client.get(BASE + f"/flows/{flow_id}")).json()["status"] == "pending"
    assert (await client.get(BASE)).json()["status"] == "not_connected"
    completed = await complete(client, flow_id)
    assert completed.status_code == 200, completed.text
    assert completed.json() == {"warning": None, "login": "example-user"}
    # The outcome stays readable, without the token, until Console drops it.
    assert (await client.get(BASE + f"/flows/{flow_id}")).json() == {
        "status": "connected",
        "login": "example-user",
        "error": None,
        "warning": None,
    }
    status = await client.get(BASE)
    assert (
        status.json()["installations"][0]["repositories"][0]["name"]
        == "example/project"
    )
    assert status.json()["sso_hidden_organizations"] == []
    assert "SYNTHETIC-ACCESS" not in status.text
    async with factory() as session:
        row = await session.scalar(
            select(ServiceConnection).where(ServiceConnection.service == "github")
        )
        assert "SYNTHETIC-ACCESS" not in row.encrypted_secret
        assert (
            json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))["access_token"]
            == "SYNTHETIC-ACCESS"
        )
        flow = await session.scalar(select(SignInFlow).where(SignInFlow.id == flow_id))
        assert flow is not None and flow.encrypted_result is None
    assert (await client.delete(BASE + f"/flows/{flow_id}")).status_code == 204
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410
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
    assert (await complete(client, flow_id)).status_code == 200
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
    # Another workspace does not see the flow at all.
    with tenant_scope("other-tenant"):
        assert (await complete(client, flow_id)).status_code == 410
    github.exchange.assert_not_called()


async def test_cancel_and_expiry_are_visible(github_app):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    assert (await client.delete(BASE + f"/flows/{flow_id}")).status_code == 204
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410
    flow_id = await authorize(client)
    async with factory() as session:
        await session.execute(
            update(SignInFlow)
            .where(SignInFlow.id == flow_id)
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    assert (await client.get(BASE + f"/flows/{flow_id}")).status_code == 410
    assert (
        await client.get(BASE + "/authorize", params={"state": flow_id})
    ).status_code == 400


async def test_a_flow_keeps_nothing_secret_in_the_clear(github_app):
    client, _, _, factory = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    assert (await complete(client, flow_id)).status_code == 200
    async with factory() as session:
        row = await session.scalar(select(SignInFlow).where(SignInFlow.id == flow_id))
    assert row is not None
    assert SECRET not in row.completion_secret_hash
    assert "SYNTHETIC-REFRESH" not in (row.encrypted_result or "")
    assert row.browser_nonce_hash is not None
    assert row.account_label == "example-user"


async def test_a_sign_in_started_on_one_process_completes_on_another(
    github_app,
):
    """Every request of the sign-in lands on the other process from the one
    before: start, the browser's two steps, completion and status."""
    _, github, identity, factory = github_app
    first = _process(github, identity, factory, False)
    second = _process(github, identity, factory, False)
    async with httpx.AsyncClient(
        transport=_EachRequestToTheNextProcess(first, second),
        base_url="https://switch.example.com",
    ) as client:
        flow_id = await authorize(client)
        await relay(client, flow_id)
        assert (await complete(client, flow_id)).status_code == 200
        assert (await client.get(BASE + f"/flows/{flow_id}")).json() == {
            "status": "connected",
            "login": "example-user",
            "error": None,
            "warning": None,
        }
        assert (await client.get(BASE)).json()["login"] == "example-user"
    github.exchange.assert_awaited_once()


async def test_two_processes_racing_to_complete_exchange_the_code_once(github_app):
    _, github, identity, factory = github_app
    first = _process(github, identity, factory, False)
    second = _process(github, identity, factory, False)
    async with httpx.AsyncClient(
        transport=_EachRequestToTheNextProcess(first, second),
        base_url="https://switch.example.com",
    ) as client:
        flow_id = await authorize(client)
        await relay(client, flow_id)
        results = await asyncio.gather(
            complete(client, flow_id), complete(client, flow_id)
        )
    assert sorted(r.status_code for r in results) == [200, 400]
    github.exchange.assert_awaited_once()


async def test_refresh_saved_before_repository_failure(github_app):
    client, github, _, factory = github_app
    flow_id = await authorize(client)
    github.exchange.return_value["expires_at"] = 0
    await relay(client, flow_id)
    await complete(client, flow_id)
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
            select(ServiceConnection).where(ServiceConnection.service == "github")
        )
        saved = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
        assert saved["refresh_token"] == "NEW-SYNTHETIC-REFRESH"


async def test_failed_authorization_preserves_saved_connection(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    await complete(client, flow_id)
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
    assert (await complete(client, first)).status_code == 200
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
    response = await complete(client, second)
    assert response.status_code == 409
    assert "already linked" in response.json()["detail"]
    assert (
        "already linked"
        in (await client.get(BASE + f"/flows/{second}")).json()["error"]
    )
    assert response.json()["code"] == "account_linked_elsewhere"
    assert response.json()["retryable"] is False
    async with factory() as session:
        rows = (await session.scalars(select(ServiceConnection))).all()
        assert len(rows) == 1
        assert rows[0].user_id == "github-user"


async def test_callback_is_taken_once_and_a_cancelled_consent_fails(github_app):
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    response = await client.get(
        BASE + "/callback", params={"state": flow_id, "code": "SYNTHETIC-CODE"}
    )
    assert response.status_code == 400
    flow_id = await authorize(client)
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
    # The second shares the fetch under way rather than starting its own; the
    # cancelled first must not take that fetch, or its new sign-in, with it.
    second = asyncio.create_task(client.get(BASE))
    await asyncio.sleep(0.2)
    assert not second.done()
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
            select(ServiceConnection).where(ServiceConnection.service == "github")
        )
        saved = json.loads(TEST_KEYRING.decrypt(row.encrypted_secret))
        assert saved["refresh_token"] == "NEW-SYNTHETIC-REFRESH"


async def test_disconnect_finishes_and_warns_when_github_revoke_fails(github_app):
    client, github, _, factory = github_app
    flow = await authorize(client)
    await relay(client, flow)
    assert (await complete(client, flow)).status_code == 200
    github.revoke.side_effect = GitHubError("Synthetic revocation failure")
    result = await client.delete(BASE)
    assert result.status_code == 200
    assert "GitHub settings" in result.json()["warning"]
    async with factory() as session:
        assert (
            await session.scalar(
                select(ServiceConnection).where(ServiceConnection.service == "github")
            )
            is None
        )


async def test_disconnect_works_once_the_app_is_removed(github_app):
    client, github, _, factory = github_app
    flow = await authorize(client)
    await relay(client, flow)
    assert (await complete(client, flow)).status_code == 200
    # As `install_github_app(state, None)` and the broker leave the server.
    state = client._transport.app.state
    state.github_connections = None
    state.service_broker.replace_adapter("github", None)
    result = await client.delete(BASE)
    assert result.status_code == 200
    assert result.json()["warning"] == (
        "GitHub is not set up on this server, so Switch could not revoke the "
        "sign-in. Revoke it at GitHub."
    )
    github.revoke.assert_not_called()
    async with factory() as session:
        assert (
            await session.scalar(
                select(ServiceConnection).where(ServiceConnection.service == "github")
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
    assert (await complete(client, first)).status_code == 200
    async with factory() as session:
        issued = ServiceTokenIssuance(
            grant_id="grant",
            agent_id="agent",
            owner_id=identity["user"].id,
            service="github",
            principal="agent_key",
            controller_id=None,
            permissions={},
            resources={},
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            token_sha256="0" * 64,
            encrypted_token=TEST_KEYRING.encrypt("SYNTHETIC-INSTALLATION"),
            revoke_requested=False,
            attempts=0,
        )
        session.add(issued)
        await session.commit()
    monkeypatch.setattr(
        GitHubInstallationCredentials,
        "revoke",
        AsyncMock(side_effect=GitHubError("Synthetic outage")),
    )
    github.exchange.return_value = {
        **github.exchange.return_value,
        "access_token": "SYNTHETIC-RELINKED-ACCESS",
    }
    second = await authorize(client)
    await relay(client, second)
    response = await complete(client, second)
    assert response.status_code == 200
    assert response.json()["warning"]
    github.revoke.assert_awaited_once_with("SYNTHETIC-ACCESS")
    async with factory() as session:
        row = await session.get(ServiceTokenIssuance, (require_tenant_id(), issued.id))
        assert row.revoke_requested and row.encrypted_token is not None


GITHUB_REFUSAL = {
    "detail": (
        "GitHub is not enabled in this workspace. Ask a workspace admin; they "
        "switch it on under Connectors in Switch Console."
    ),
    "code": "forbidden",
    "retryable": False,
}


async def _switch_github(factory, user_id: str, enabled: bool) -> None:
    async with factory() as session:
        await WorkspaceServiceStore().set_enabled(session, "github", enabled, user_id)
        await session.commit()


async def _start(client):
    return await client.post(
        BASE + "/flows",
        json={
            "port": 12345,
            "state": secrets.token_urlsafe(32),
            "completion_secret": SECRET,
        },
    )


@pytest.mark.parametrize("github_app", [True], indirect=True)
async def test_start_is_refused_where_the_workspace_switched_github_off(github_app):
    client, github, identity, factory = github_app
    await _switch_github(factory, identity["user"].id, False)
    response = await _start(client)
    assert response.status_code == 403
    assert response.json() == GITHUB_REFUSAL
    async with factory() as session:
        assert await session.scalar(select(SignInFlow)) is None


async def test_with_the_flag_off_the_workspace_switch_is_ignored(github_app):
    client, _, identity, factory = github_app
    await _switch_github(factory, identity["user"].id, False)
    assert (await _start(client)).status_code == 200


@pytest.mark.parametrize("github_app", [True], indirect=True)
async def test_switched_off_mid_flow_the_sign_in_is_revoked_and_not_kept(github_app):
    client, github, identity, factory = github_app
    await _switch_github(factory, identity["user"].id, True)
    flow_id = await authorize(client)
    await relay(client, flow_id)
    await _switch_github(factory, identity["user"].id, False)

    response = await complete(client, flow_id)

    assert response.status_code == 403
    assert response.json() == GITHUB_REFUSAL
    github.revoke.assert_awaited_once_with("SYNTHETIC-ACCESS")
    async with factory() as session:
        flow = await session.scalar(select(SignInFlow).where(SignInFlow.id == flow_id))
        assert flow is not None
        assert (flow.status, flow.encrypted_result) == ("failed", None)
        assert flow.error == GITHUB_REFUSAL["detail"]
        assert await session.scalar(select(ServiceConnection)) is None


async def test_the_connection_records_the_apps_client(github_app):
    client, _, _, factory = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    assert (await complete(client, flow_id)).status_code == 200
    async with factory() as session:
        row = await session.scalar(
            select(ServiceConnection).where(ServiceConnection.service == "github")
        )
    assert row.oauth_client_id == "example-client"


async def test_an_app_replaced_during_the_sign_in_is_refused(github_app):
    """The sign-in carried over to an App with another client: its code was
    issued to the old one, so it is refused before GitHub is asked."""
    client, github, _, _ = github_app
    flow_id = await authorize(client)
    await relay(client, flow_id)
    github.client_id = "another-client"
    response = await complete(client, flow_id)
    assert response.status_code == 400
    assert response.json()["detail"] == (
        "This server's GitHub App changed during your sign-in. Start it again."
    )
    github.exchange.assert_not_called()
