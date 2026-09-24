from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from switch_core.crypto import encrypt_token
from switch_core.db.models import HostedLaunch, User, require_tenant_id
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.hosted_launches import router
from switch_core.providers.claude_verifier import ClaudeVerificationError


@pytest.fixture
async def launch_app(session_factory, monkeypatch):
    async with session_factory() as session:
        owner = User(
            id="cloud-owner",
            name="Owner",
            email="cloud@example.com",
            role="user",
            password_hash="unused",
        )
        session.add(owner)
        await session.flush()
        await ProviderConnectionStore().save(
            session,
            owner.id,
            "setup-token",
            encrypt_token("SYNTHETIC-CREDENTIAL", "SYNTHETIC-KEY"),
            datetime.now(UTC),
        )
        await session.commit()
    app = FastAPI()
    app.include_router(router)
    verifier = AsyncMock()
    app.state.claude_verifier = verifier
    app.state.github_connections = object()
    app.state.hosted_controller_settings = SimpleNamespace(
        tenant_id=require_tenant_id(),
        agent_ids=["00000000-0000-4000-8000-000000000001"],
    )
    config = SimpleNamespace(
        hosted_launch_capacity=1,
        hosted_agents_per_owner=3,
        hosted_sessions_per_agent=2,
        jwt_secret_key="SYNTHETIC-KEY",
    )
    identity = {"user": owner}

    async def sessions():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_config] = lambda: config
    access = AsyncMock(
        return_value={
            "installations": [
                {"id": 123, "repositories": [{"id": 456, "name": "example/project"}]}
            ]
        }
    )
    monkeypatch.setattr("switch_core.gateway.hosted_launches.connection_status", access)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, verifier, access, config, identity, session_factory


def body():
    return {
        "request_id": str(uuid4()),
        "name": "helper",
        "description": "Repository helper",
        "display_name": None,
        "icon_url": None,
        "instructions": "",
        "definition": "---\nname: helper\ndescription: Repository helper\n---\nRepository helper\n",
        "installation_id": 123,
        "repository_id": 456,
        "definition_attributes": {"model": "sonnet"},
        "auto_session": True,
        "auto_approve": False,
        "addressing_policy": None,
    }


async def test_request_is_durable_idempotent_and_never_returns_credentials(launch_app):
    client, verifier, access, _, identity, factory = launch_app
    request = body()
    result = await client.post("/hosted-launches", json=request)
    assert result.status_code == 202
    assert result.json()["state"] == "queued"
    assert "SYNTHETIC" not in result.text
    verifier.verify.assert_awaited_once_with("setup-token", "SYNTHETIC-CREDENTIAL")
    second = await client.post("/hosted-launches", json=request)
    assert second.json() == result.json()
    assert verifier.verify.await_count == 1
    assert access.await_count == 1
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(HostedLaunch)) == 1
    identity["user"] = SimpleNamespace(id="someone-else")
    assert (
        await client.get("/hosted-launches/" + request["request_id"])
    ).status_code == 404


async def test_disabled_server_refuses_before_verifying_credentials(launch_app):
    client, verifier, _, config, _, _ = launch_app
    config.hosted_launch_capacity = 0
    assert (await client.post("/hosted-launches", json=body())).status_code == 503
    verifier.verify.assert_not_called()


async def test_expired_claude_or_missing_repository_never_queues(launch_app):
    client, verifier, access, _, _, factory = launch_app
    verifier.verify.side_effect = ClaudeVerificationError("Credential no longer works.")
    assert (await client.post("/hosted-launches", json=body())).status_code == 422
    access.assert_not_called()
    verifier.verify.side_effect = None
    access.return_value = {"installations": []}
    assert (await client.post("/hosted-launches", json=body())).status_code == 422
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(HostedLaunch)) == 0


async def test_changed_request_and_unexpected_credentials_are_rejected(launch_app):
    client, _, _, _, _, _ = launch_app
    request = body()
    assert (await client.post("/hosted-launches", json=request)).status_code == 202
    assert (
        await client.post("/hosted-launches", json=request | {"name": "different"})
    ).status_code == 409
    assert (
        await client.post("/hosted-launches", json=body() | {"credential": "SYNTHETIC"})
    ).status_code == 422


@pytest.mark.parametrize("change", [{"instructions": "x" * 32768}])
async def test_rejects_unlaunchable_configuration_before_verifying_credentials(
    launch_app, change
):
    client, verifier, access, *_ = launch_app
    response = await client.post("/hosted-launches", json=body() | change)
    assert response.status_code == 422
    verifier.verify.assert_not_awaited()
    access.assert_not_awaited()


async def test_manual_cloud_agents_are_supported(launch_app):
    client, *_ = launch_app
    assert (
        await client.post("/hosted-launches", json=body() | {"auto_session": False})
    ).status_code == 202


async def test_lifecycle_owner_revision_and_removal_guards(launch_app):
    client, _, _, _, identity, factory = launch_app
    request = body()
    created = (await client.post("/hosted-launches", json=request)).json()
    url = f"/hosted-launches/{request['request_id']}/lifecycle"
    owner = identity["user"]
    identity["user"] = SimpleNamespace(id="someone-else")
    assert (
        await client.post(url, json={"action": "stop", "revision": 1})
    ).status_code == 404
    identity["user"] = owner
    assert (
        await client.post(url, json={"action": "remove", "revision": 1})
    ).status_code == 409
    stopped = await client.post(url, json={"action": "stop", "revision": 1})
    assert stopped.json()["desired_state"] == "stopped"
    assert stopped.json()["revision"] == 2
    assert (
        await client.post(url, json={"action": "start", "revision": 1})
    ).status_code == 409
    async with factory() as session:
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), created["request_id"])
        )
        launch.state = "stopped"
        await session.commit()
    removed = await client.post(url, json={"action": "remove", "revision": 2})
    assert removed.json()["desired_state"] == "deleted"
    assert (
        await client.post(url, json={"action": "start", "revision": 3})
    ).status_code == 409


async def test_lifecycle_action_ends_an_idle_sleep(launch_app):
    client, _, _, _, _, factory = launch_app
    request = body()
    await client.post("/hosted-launches", json=request)
    async with factory() as session:
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), request["request_id"])
        )
        launch.desired_state = "stopped"
        launch.state = "stopped"
        launch.sleeping = True
        await session.commit()
    url = f"/hosted-launches/{request['request_id']}"
    assert (await client.get(url)).json()["sleeping"] is True
    started = await client.post(
        url + "/lifecycle", json={"action": "start", "revision": 1}
    )
    assert started.json()["desired_state"] == "running"
    assert started.json()["sleeping"] is False


async def test_session_operations_are_owner_scoped_and_idempotent(launch_app):
    client, _, _, _, identity, factory = launch_app
    request = body()
    await client.post("/hosted-launches", json=request)
    url = f"/hosted-launches/{request['request_id']}/sessions"
    operation = {"id": str(uuid4()), "session_id": str(uuid4()), "action": "start"}
    assert (await client.post(url, json=operation)).status_code == 409
    async with factory() as session:
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), request["request_id"])
        )
        launch.state = "ready"
        await session.commit()
    first = await client.post(url, json=operation)
    assert first.status_code == 202
    assert first.json()["state"] == "queued"
    assert (await client.post(url, json=operation)).json() == first.json()
    assert (
        await client.post(url, json=operation | {"session_id": str(uuid4())})
    ).status_code == 409
    assert (
        await client.post(url, json=operation | {"id": str(uuid4())})
    ).status_code == 409
    identity["user"] = SimpleNamespace(id="someone-else")
    assert (await client.get(url + "/" + operation["id"])).status_code == 404
    assert (await client.post(url, json=operation)).status_code == 404


@pytest.mark.parametrize("stale", [False, True])
async def test_stop_sleeping_worker_prevents_mention_wake(launch_app, stale):
    client, _, _, _, _, factory = launch_app
    request = body()
    await client.post("/hosted-launches", json=request)
    async with factory() as session:
        launch = await session.get(
            HostedLaunch, (require_tenant_id(), request["request_id"])
        )
        launch.desired_state = "stopped"
        launch.state = "stopped"
        launch.sleeping = True
        launch.revision = 2
        await session.commit()
    stopped = await client.post(
        f"/hosted-launches/{request['request_id']}/lifecycle",
        json={"action": "stop", "revision": 1 if stale else 2},
    )
    assert stopped.status_code == 200
    assert stopped.json()["sleeping"] is False
    assert stopped.json()["state"] == "stopped"
    async with factory() as session:
        launch = await HostedLaunchStore().note_addressed(
            session, request["request_id"]
        )
        assert launch.desired_state == "stopped"
        assert launch.revision == 3
