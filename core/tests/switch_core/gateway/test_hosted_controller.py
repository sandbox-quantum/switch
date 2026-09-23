import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from switch_core.bridges.agent.api.hosted_routes import router as worker_router
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config as get_worker_config
from switch_core.bridges.agent.dependencies import get_session as get_worker_session
from switch_core.bridges.agent.protocol.service import AgentExistsError
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    Agent,
    HostedLaunch,
    HostedOperation,
    ProviderConnection,
    TenantMember,
    require_tenant_id,
)
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import router
from switch_core.providers.github_installation import RepositoryCredential
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    make_owner,
    make_service,
)

TOKEN = "SYNTHETIC-CONTROLLER-CREDENTIAL-FOR-TESTS"


@pytest.fixture
async def controller_app(session_factory, monkeypatch, tmp_path):
    owner = await make_owner(session_factory)
    request_id = str(uuid4())
    agent_id = str(uuid4())
    spec = {
        "description": "Cloud helper",
        "display_name": None,
        "icon_url": None,
        "instructions": "Help with the repository.",
        "auto_session": True,
        "auto_approve": False,
        "addressing_policy": None,
        "definition_attributes": {},
        "installation_id": 123,
        "repository_id": 456,
    }
    async with session_factory() as session:
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner, role="member")
        )
        session.add(
            HostedLaunch(
                id=request_id,
                owner_id=owner,
                name="cloud-helper",
                spec=spec,
                state="queued",
                agent_id=agent_id,
            )
        )
        session.add(
            ProviderConnection(
                user_id=owner,
                provider="github",
                kind="oauth",
                encrypted_credential=encrypt_token(
                    json.dumps({"access_token": "SYNTHETIC-GITHUB"}), "test-secret"
                ),
                verified_at=datetime.now(UTC),
            )
        )
        await ProviderConnectionStore().save(
            session,
            owner,
            "setup-token",
            encrypt_token("SYNTHETIC-CLAUDE", "test-secret"),
            datetime.now(UTC),
        )
        await session.commit()
    service = make_service(session_factory)
    service.connections = SimpleNamespace(for_agent=lambda _: [])
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        agent_ids=[UUID(agent_id)],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.state.github_connections = SimpleNamespace(client_id="synthetic-app")
    app.include_router(router)
    app.include_router(worker_router)
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps({**settings.model_dump(mode="json"), "token": TOKEN})
    )
    service.config.hosted_controller_config_path = str(settings_path)
    service.config.hosted_github_config_path = "/tmp/synthetic-github.json"

    async def worker_session():
        async with session_factory() as session:
            yield session

    async def worker_agent():
        async with session_factory() as session:
            return await session.get(Agent, agent_id)

    app.dependency_overrides[get_agent_from_scope] = worker_agent
    app.dependency_overrides[get_worker_config] = lambda: service.config
    app.dependency_overrides[get_worker_session] = worker_session
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: service.config
    app.dependency_overrides[get_protocol] = lambda: service
    monkeypatch.setattr(
        "switch_core.gateway.hosted_controller.connection_status", AsyncMock()
    )
    issue = AsyncMock(
        return_value=RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )
    )
    monkeypatch.setattr(
        "switch_core.gateway.hosted_controller.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue),
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.connection_status", AsyncMock()
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubConnections",
        lambda _: app.state.github_connections,
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, request_id, agent_id, service, session_factory, settings


async def test_controller_requires_its_own_credential(controller_app):
    client, request_id, *_ = controller_app
    for path in (
        "/hosted-controller",
        f"/hosted-controller/{request_id}/prepare",
        f"/hosted-controller/{request_id}/observation",
    ):
        for token in (None, "Bearer wrong"):
            response = await client.request(
                "GET" if path == "/hosted-controller" else "POST",
                path,
                headers={} if token is None else {"Authorization": token},
                json={} if path.endswith("prepare") else {"state": "running"},
            )
            assert response.status_code == 401


async def test_prepare_registers_once_and_does_not_create_a_room(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    headers = {"Authorization": "Bearer " + TOKEN}
    responses = [
        await client.post(f"/hosted-controller/{request_id}/prepare", headers=headers)
        for _ in range(2)
    ]
    assert all(response.status_code == 200 for response in responses), [
        response.text for response in responses
    ]
    assert (
        responses[0].json()["switch_credentials"]
        == responses[1].json()["switch_credentials"]
    )
    assert responses[0].headers["cache-control"] == "no-store"
    assert len(service.client_lifecycle.started) == 1
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(Agent)) == 1
        agent = await session.get(Agent, agent_id)
        assert agent.integration_profile["connection_model"] == "auto_session"
        assert agent.addressing_policy is not None
    status = await client.get("/hosted-controller", headers=headers)
    assert "SYNTHETIC" not in status.text
    assert "switch_credentials" not in status.text


async def test_running_vm_is_not_ready_without_the_watcher(controller_app):
    client, request_id, _, service, _, _ = controller_app
    headers = {"Authorization": "Bearer " + TOKEN}
    first = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers=headers,
        json={"state": "running", "revision": 1},
    )
    assert first.json()["state"] == "provisioning"
    service.connections.for_agent = lambda _: [SimpleNamespace(spawn_capable=True)]
    ready = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers=headers,
        json={"state": "running", "revision": 1},
    )
    assert ready.json()["state"] == "ready"


async def test_worker_renewal_is_bound_to_its_owner_and_selected_repository(
    controller_app,
):
    client, request_id, agent_id, _, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    renewed = await client.post("/hosted/github-credential")
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["repository"] == "example/project"
    assert renewed.headers["cache-control"] == "no-store"
    async with factory() as session:
        row = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        row.agent_id = str(uuid4())
        await session.commit()
    denied = await client.post("/hosted/github-credential")
    assert denied.status_code == 403
    assert "SYNTHETIC" not in denied.text


async def test_prepare_reports_a_name_taken_during_provisioning(
    controller_app, monkeypatch
):
    client, request_id, _, service, *_ = controller_app
    monkeypatch.setattr(
        service, "register_agent", AsyncMock(side_effect=AgentExistsError())
    )
    response = await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 422
    assert "name" in response.json()["detail"]


async def test_worker_claim_is_durable_and_stale_claim_is_not_replayed(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    operation_id = str(uuid4())
    async with factory() as session:
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                session_id=str(uuid4()),
                action="start",
            )
        )
        await session.commit()
    claim = await client.post("/hosted/operations/claim")
    assert claim.json()["id"] == operation_id
    assert claim.json()["state"] == "claimed"
    assert (await client.post("/hosted/operations/claim")).json() is None
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        row.updated_at = datetime.now(UTC) - timedelta(minutes=6)
        await session.commit()
    assert (await client.post("/hosted/operations/claim")).json() is None
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.state == "unknown"
    assert (
        await client.post(
            f"/hosted/operations/{operation_id}/result",
            json={"state": "applied", "error": None},
        )
    ).status_code == 409


async def test_provider_refresh_and_revocation_are_owner_bound(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    response = await client.post("/hosted/provider-credential")
    assert response.status_code == 200
    assert response.json()["status"] == "connected"
    assert response.headers["cache-control"] == "no-store"
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().delete(session, launch.owner_id)
        await session.commit()
    assert (await client.post("/hosted/provider-credential")).json() == {
        "status": "revoked"
    }
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.desired_state = "deleted"
        await session.commit()
    assert (await client.post("/hosted/provider-credential")).status_code == 403
    assert (await client.post("/hosted/operations/claim")).status_code == 403
    assert (await client.post("/hosted/github-credential")).status_code == 403


async def test_old_controller_observation_cannot_overwrite_new_desired_state(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.revision = 2
        launch.desired_state = "stopped"
        launch.state = "stopping"
        await session.commit()
    response = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "running", "revision": 1},
    )
    assert response.json()["state"] == "stopping"
    assert response.json()["desired_state"] == "stopped"


async def test_error_is_preserved_until_explicit_lifecycle_retry(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "error"
        launch.error = "Reconnect the provider."
        await session.commit()
    for state in ["stopping", "stopped", "running"]:
        response = await client.post(
            f"/hosted-controller/{request_id}/observation",
            headers={"Authorization": "Bearer " + TOKEN},
            json={"state": state, "revision": 1},
        )
        assert response.json()["state"] == "error"
        assert response.json()["error"] == "Reconnect the provider."


async def test_startup_without_connection_times_out_with_actionable_error(
    controller_app,
):
    client, request_id, _, _, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "provisioning"
        launch.updated_at = datetime.now(UTC) - timedelta(minutes=11)
        await session.commit()
    result = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "running", "revision": 1},
    )
    assert result.json()["state"] == "error"
    assert "10 minutes" in result.json()["error"]


async def test_running_observation_does_not_undo_requested_stop(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "stopping"
        launch.desired_state = "stopped"
        await session.commit()
    result = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "running", "revision": 1},
    )
    assert result.json()["state"] == "stopping"
