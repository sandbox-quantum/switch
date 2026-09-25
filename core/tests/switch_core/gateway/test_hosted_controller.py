import asyncio
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, text

from switch_core.bridges.agent.api.hosted_cutover_routes import (
    router as hosted_cutover_router,
)
from switch_core.bridges.agent.api.hosted_routes import router as worker_router
from switch_core.bridges.agent.api.hosted_worker_routes import (
    router as hosted_worker_router,
)
from switch_core.bridges.agent.auth import get_agent_from_scope
from switch_core.bridges.agent.dependencies import get_config as get_worker_config
from switch_core.bridges.agent.dependencies import get_protocol as get_worker_protocol
from switch_core.bridges.agent.dependencies import get_session as get_worker_session
from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.hosted_workers import IdleReport, WorkerBinding
from switch_core.bridges.agent.protocol.service import AgentExistsError
from switch_core.crypto import encrypt_token
from switch_core.db.models import (
    Agent,
    ApiKey,
    GitHubIssuedToken,
    HostedLaunch,
    HostedOperation,
    ProviderConnection,
    Skill,
    TenantMember,
    User,
    agent_skills,
    require_tenant_id,
)
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_protocol,
    get_session,
    get_session_factory,
)
from switch_core.gateway.hosted_controller import launch_by_id, router
from switch_core.gateway.hosted_launches import router as launch_router
from switch_core.gateway.hosted_relay import router as relay_router
from switch_core.providers.github_installation import (
    GitHubInstallationCredentials,
    RepositoryCredential,
)
from switch_core.providers.github_revocations import queue_revocation, revoke_pending
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import (
    PROFILE,
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
                    json.dumps(
                        {
                            "access_token": "SYNTHETIC-GITHUB",
                            "expires_at": (
                                datetime.now(UTC) + timedelta(hours=1)
                            ).timestamp(),
                        }
                    ),
                    "test-secret",
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
    service.connections = ConnectionRegistry()
    service.event_buffer = SimpleNamespace(boot=1, remove=Mock())
    service.config.hosted_idle_stop_minutes = 0
    settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=TOKEN,
        agent_ids=[UUID(agent_id)],
        github_private_key_path="/tmp/synthetic-signing-key.pem",
        agent_api_endpoint="https://switch.example.com/api/agent",
    )
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", AsyncMock())
    app = FastAPI()
    app.state.hosted_controller_settings = settings
    app.state.github_connections = SimpleNamespace(client_id="synthetic-app")
    app.include_router(router)
    app.include_router(worker_router)
    app.include_router(hosted_worker_router, prefix="/agents")
    app.include_router(hosted_cutover_router, prefix="/agents")
    app.include_router(launch_router)
    app.include_router(relay_router)
    settings_path = tmp_path / "controller.json"
    settings_path.write_text(
        json.dumps({**settings.model_dump(mode="json"), "token": TOKEN})
    )
    service.config.hosted_controller_config_path = str(settings_path)
    service.config.hosted_github_config_path = "/tmp/synthetic-github.json"

    async def worker_session():
        async with session_factory() as session:
            yield session

    async def current_user():
        async with session_factory() as session:
            return await session.get(User, owner)

    app.dependency_overrides[get_current_user] = current_user
    app.dependency_overrides[get_session] = worker_session

    async def worker_agent():
        async with session_factory() as session:
            return await session.get(Agent, agent_id)

    app.dependency_overrides[get_agent_from_scope] = worker_agent
    app.dependency_overrides[get_worker_config] = lambda: service.config
    app.dependency_overrides[get_worker_session] = worker_session
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_config] = lambda: service.config
    app.dependency_overrides[get_protocol] = lambda: service
    app.dependency_overrides[get_worker_protocol] = lambda: service
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
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubConnections",
        lambda _: app.state.github_connections,
    )
    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, request_id, agent_id, service, session_factory, settings


def attach_worker(
    service,
    agent_id: str,
    request_id: str,
    *,
    revision: int = 1,
    boot_id: str = "boot-a",
    connection_id: str | None = None,
) -> Connection:
    conn = service.connections.open(
        agent_id=agent_id,
        connection_id=connection_id or str(uuid4()),
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        cursor=0,
        declaration=ClientDeclaration(speaks=7, accepts=1),
        expected_generation=None,
    )
    service.connections.bind_worker(
        conn, WorkerBinding(request_id, revision, boot_id, "instance-a"), {}
    )
    return conn


def fence(conn: Connection) -> dict:
    return {"connection_id": conn.id, "generation": conn.stream_generation}


def report_idle(service, conn: Connection, *, busy: bool = False, seq: int = 1) -> None:
    assert conn.worker is not None
    service.connections.record_idle_report(
        conn,
        IdleReport(
            report_seq=seq,
            relays_through=0,
            busy=busy,
            reasons=[],
            sessions={},
            launch_revision=conn.worker.launch_revision,
            generation=conn.stream_generation,
            received_monotonic=time.monotonic(),
            received_at=datetime.now(UTC),
        ),
    )


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
    client, request_id, service_agent_id, service, _, _ = controller_app
    headers = {"Authorization": "Bearer " + TOKEN}
    first = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers=headers,
        json={"state": "running", "revision": 1},
    )
    assert first.json()["state"] == "provisioning"
    attach_worker(service, service_agent_id, request_id)
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
    client, request_id, agent_id, service, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    conn = attach_worker(service, agent_id, request_id)
    operation_id = str(uuid4())
    async with factory() as session:
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                launch_revision=1,
                session_id=str(uuid4()),
                action="start",
            )
        )
        await session.commit()
    claim_path = f"/hosted/operations/{operation_id}/claim"
    claim = await client.post(claim_path, json=fence(conn))
    assert claim.status_code == 200, claim.text
    assert claim.json()["id"] == operation_id
    assert claim.json()["state"] == "claimed"
    second = await client.post(claim_path, json=fence(conn))
    assert second.status_code == 409
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.claimed_by == f"1:{conn.id}:{conn.stream_generation}"
        assert row.claimed_boot_id == "boot-a"
        row.updated_at = datetime.now(UTC) - timedelta(minutes=6)
        await session.commit()
    async with factory() as session:
        await HostedLaunchStore().fail_stale_operations(session, request_id, 1)
        await session.commit()
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.state == "unknown"
    assert (
        await client.post(
            f"/hosted/operations/{operation_id}/result",
            json={**fence(conn), "state": "applied", "error": None},
        )
    ).status_code == 409


async def _queued_operation(factory, request_id: str, revision: int = 1) -> str:
    operation_id = str(uuid4())
    async with factory() as session:
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                launch_revision=revision,
                session_id=str(uuid4()),
                action="start",
            )
        )
        await session.commit()
    return operation_id


async def test_operation_claim_is_refused_to_a_non_worker(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    operation_id = await _queued_operation(factory, request_id)
    plain = service.connections.open(
        agent_id=agent_id,
        connection_id=str(uuid4()),
        scope="all",
        delivery_filter="all",
        spawn_capable=True,
        cursor=0,
        declaration=ClientDeclaration(speaks=7, accepts=1),
        expected_generation=None,
    )
    refused = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(plain)
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "hosted_worker_only"
    worker = attach_worker(service, agent_id, request_id)
    stale = {**fence(worker), "generation": worker.stream_generation + 1}
    refused = await client.post(f"/hosted/operations/{operation_id}/claim", json=stale)
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "generation_changed"


async def test_lost_result_is_reposted_from_a_later_generation(controller_app):
    client, request_id, agent_id, service, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    operation_id = await _queued_operation(factory, request_id)
    conn = attach_worker(service, agent_id, request_id)
    claimed = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(conn)
    )
    assert claimed.status_code == 200
    reattached = attach_worker(service, agent_id, request_id, connection_id=conn.id)
    result_path = f"/hosted/operations/{operation_id}/result"
    body = {**fence(reattached), "state": "applied", "error": None}
    first = await client.post(result_path, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["state"] == "applied"
    again = await client.post(result_path, json=body)
    assert again.status_code == 200
    other_boot = attach_worker(
        service, agent_id, request_id, connection_id=conn.id, boot_id="boot-b"
    )
    refused = await client.post(
        result_path, json={**fence(other_boot), "state": "applied", "error": None}
    )
    assert refused.status_code == 409


async def test_operation_insert_rings_the_worker(controller_app, monkeypatch):
    client, request_id, agent_id, service, factory, _ = controller_app
    monkeypatch.setattr(
        "switch_core.gateway.hosted_launches.OPERATION_RERING_SECONDS", 0.01
    )
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "ready"
        await session.commit()
    conn = attach_worker(service, agent_id, request_id)
    conn.worker_frames.drain()
    body = {"id": str(uuid4()), "session_id": str(uuid4()), "action": "start"}
    created = await client.post(f"/hosted-launches/{request_id}/sessions", json=body)
    assert created.status_code == 202, created.text
    assert created.json()["state"] == "queued"
    again = await client.post(f"/hosted-launches/{request_id}/sessions", json=body)
    assert again.json()["id"] == body["id"]
    other = await client.post(
        f"/hosted-launches/{request_id}/sessions",
        json={**body, "id": str(uuid4())},
    )
    assert other.status_code == 409
    await asyncio.sleep(0.2)
    rings = [data for event, data in conn.worker_frames.drain() if event == "operation"]
    assert rings and all(data == {"id": body["id"]} for data in rings)
    assert len(rings) <= 1 + 2 * 6
    claimed = await client.post(
        f"/hosted/operations/{body['id']}/claim", json=fence(conn)
    )
    assert claimed.status_code == 200
    await asyncio.sleep(0.1)
    assert not [e for e, _ in conn.worker_frames.drain() if e == "operation"]


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


async def _idle_ready(controller_app, *, minutes: int, **spec) -> Connection:
    _, request_id, agent_id, service, factory, _ = controller_app
    service.config.hosted_idle_stop_minutes = minutes
    conn = attach_worker(service, agent_id, request_id)
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.spec = {**launch.spec, **spec}
        launch.state = "ready"
        launch.active_at = datetime.now(UTC) - timedelta(minutes=31)
        await session.commit()
    return conn


async def _observe_running(controller_app) -> dict:
    client, request_id, *_ = controller_app
    response = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "running", "revision": 1},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_idle_stop_is_off_when_unset(controller_app):
    await _idle_ready(controller_app, minutes=0)
    result = await _observe_running(controller_app)
    assert result["state"] == "ready"
    assert result["sleeping"] is False


async def test_worker_without_auto_session_is_never_idle_stopped(controller_app):
    await _idle_ready(controller_app, minutes=30, auto_session=False)
    assert (await _observe_running(controller_app))["state"] == "ready"


async def test_idle_stop_refuses_to_guess_whether_a_worker_is_idle(controller_app):
    await _idle_ready(controller_app, minutes=30)
    result = await _observe_running(controller_app)
    assert result["state"] == "ready"
    assert result["sleeping"] is False


async def test_idle_stop_on_fresh_idle_report(controller_app):
    service = controller_app[3]
    conn = await _idle_ready(controller_app, minutes=30)
    report_idle(service, conn)
    result = await _observe_running(controller_app)
    assert result["state"] == "stopping"
    assert result["sleeping"] is True
    assert service.connections.get(conn.id) is None


async def test_busy_idle_report_renews_activity(controller_app):
    service = controller_app[3]
    conn = await _idle_ready(controller_app, minutes=30)
    report_idle(service, conn, busy=True)
    result = await _observe_running(controller_app)
    assert result["state"] == "ready"
    assert result["sleeping"] is False


async def test_preparation_does_not_hold_launch_lock_during_github_call(
    controller_app, monkeypatch
):
    client, request_id, _, _, factory, _ = controller_app

    async def issue(*args):
        async with factory() as session:
            launch = await asyncio.wait_for(
                launch_by_id(session, UUID(request_id)), timeout=1
            )
            launch.desired_state = "stopped"
            launch.revision += 1
            await session.commit()
        return RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )

    monkeypatch.setattr(
        "switch_core.gateway.hosted_controller.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    result = await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
        json={},
    )
    assert result.status_code == 409
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert launch.desired_state == "stopped"


async def test_previous_stopped_observation_cannot_label_a_wake_stopped(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    result = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "stopped", "revision": 1},
    )
    assert result.status_code == 200
    assert result.json()["state"] == "provisioning"


async def test_provider_status_waits_then_rejects_replaced_revision(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    old = (await client.post("/hosted/provider-credential")).json()
    async with factory() as writer:
        launch = await writer.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().lock_user(writer, launch.owner_id)
        connection = await writer.get(
            ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
        )
        replacement = connection.verified_at + timedelta(seconds=1)
        connection.verified_at = replacement
        connection.verification_status = "configured"
        request = asyncio.create_task(
            client.post(
                "/hosted/provider-status",
                json={
                    "authenticated": True,
                    "revision": old["revision"],
                },
            )
        )
        try:
            await asyncio.sleep(0.05)
            assert not request.done()
        finally:
            await writer.commit()
        response = await asyncio.wait_for(request, timeout=5)
        assert response.status_code == 409
    async with factory() as db:
        saved = await db.get(
            ProviderConnection, (require_tenant_id(), launch.owner_id, "claude")
        )
        assert saved.verified_at == replacement
        assert saved.verification_status == "configured"


@pytest.mark.parametrize("desired", ["stopped", "removed"])
async def test_provider_status_does_not_overwrite_stop_during_lock_wait(
    controller_app, desired
):
    client, request_id, _, _, factory, _ = controller_app
    await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    old = (await client.post("/hosted/provider-credential")).json()
    async with factory() as writer:
        launch = await writer.get(HostedLaunch, (require_tenant_id(), request_id))
        await ProviderConnectionStore().lock_user(writer, launch.owner_id)
        request = asyncio.create_task(
            client.post(
                "/hosted/provider-status",
                json={"authenticated": False, "revision": old["revision"]},
            )
        )
        try:
            await asyncio.sleep(0.05)
            assert not request.done()
            launch.desired_state = desired
            launch.state = "stopping"
        finally:
            await writer.commit()
        response = await asyncio.wait_for(request, timeout=5)
        assert response.status_code == 409
    async with factory() as db:
        saved = await db.get(HostedLaunch, (require_tenant_id(), request_id))
        assert saved.desired_state == desired
        assert saved.state == "stopping"


async def test_queued_launch_times_out_without_a_worker(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.updated_at = datetime.now(UTC) - timedelta(minutes=11)
        await session.commit()
    response = await client.get(
        "/hosted-controller", headers={"Authorization": "Bearer " + TOKEN}
    )
    assert response.status_code == 200
    launch = next(row for row in response.json() if row["request_id"] == request_id)
    assert launch["state"] == "error"
    assert "not scheduled" in launch["error"]


@pytest.mark.parametrize("change", ["stop", "relink", "disconnect", "revoke_failure"])
async def test_worker_token_is_revoked_when_authorization_changes_during_issue(
    controller_app, monkeypatch, change
):
    client, request_id, _, _, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    revoke = AsyncMock(
        side_effect=RuntimeError("Synthetic revocation failure")
        if change == "revoke_failure"
        else None
    )

    async def issue(*args):
        async with factory() as session:
            launch = await asyncio.wait_for(launch_by_id(session, UUID(request_id)), 1)
            if change in ("stop", "revoke_failure"):
                launch.desired_state = "stopped"
                launch.revision += 1
            else:
                row = await session.get(
                    ProviderConnection, (require_tenant_id(), launch.owner_id, "github")
                )
                if change == "disconnect":
                    await session.delete(row)
                else:
                    row.verified_at = datetime.now(UTC) + timedelta(seconds=1)
            await session.commit()
        return RepositoryCredential(
            "SYNTHETIC-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )

    monkeypatch.setattr(
        "switch_core.bridges.agent.api.hosted_routes.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=revoke),
    )
    response = await client.post("/hosted/github-credential")
    assert response.status_code == 409
    revoke.assert_awaited_once_with("SYNTHETIC-REPOSITORY")
    if change == "revoke_failure":
        async with factory() as session:
            queued = await session.scalar(
                select(GitHubIssuedToken).where(
                    GitHubIssuedToken.revoke_requested.is_(True)
                )
            )
            assert queued is not None
    assert "SYNTHETIC-REPOSITORY" not in response.text


async def test_local_registration_cannot_take_a_reserved_cloud_name(controller_app):
    _, request_id, _, service, factory, _ = controller_app
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        owner_id = launch.owner_id
    with pytest.raises(AgentExistsError, match="cloud launch already reserves"):
        await service.register_agent(
            name="cloud-helper",
            description="Local helper",
            connector_type="test",
            integration_profile=PROFILE,
            owner_id=owner_id,
        )
    async with factory() as session:
        assert (
            await session.scalar(select(Agent).where(Agent.name == "cloud-helper"))
            is None
        )


@pytest.mark.parametrize("state", ["queued", "claimed"])
async def test_operations_from_an_earlier_worker_are_not_claimed_or_completed(
    controller_app, state
):
    client, request_id, agent_id, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    conn = attach_worker(service, agent_id, request_id, revision=2)
    operation_id = str(uuid4())
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.revision = 2
        session.add(
            HostedOperation(
                id=operation_id,
                launch_id=request_id,
                launch_revision=1,
                session_id=str(uuid4()),
                action="start",
                state=state,
            )
        )
        await session.commit()
    claim = await client.post(
        f"/hosted/operations/{operation_id}/claim", json=fence(conn)
    )
    assert claim.status_code == 409
    response = await client.post(
        f"/hosted/operations/{operation_id}/result",
        json={**fence(conn), "state": "applied", "error": None},
    )
    assert response.status_code == 409
    async with factory() as session:
        await HostedLaunchStore().fail_stale_operations(session, request_id, 2)
        await session.commit()
    async with factory() as session:
        row = await session.get(HostedOperation, (require_tenant_id(), operation_id))
        assert row.state == ("unknown" if state == "claimed" else "failed")
        assert "worker changed" in row.error.lower()


@pytest.mark.parametrize("fail_cleanup", [False, True])
async def test_removed_worker_releases_name_and_revokes_switch_key(
    controller_app, fail_cleanup
):
    client, request_id, agent_id, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    service.client_lifecycle.stop = AsyncMock()

    cleanup_calls = 0

    async def delete_client_record(session, client_id):
        nonlocal cleanup_calls
        cleanup_calls += 1
        if fail_cleanup and cleanup_calls == 2:
            raise RuntimeError("Synthetic client cleanup interruption")
        await ClientStore().delete(session, client_id)

    service.client_lifecycle.delete_record = AsyncMock(side_effect=delete_client_record)
    service.event_buffer = SimpleNamespace(remove=Mock())
    async with factory() as session:
        agent = await session.get(Agent, agent_id)
        key_id = agent.api_key_id
        skill = Skill(
            name="owned-skill",
            version="1",
            description="Skill",
            visibility="private",
            owner_agent_id=agent_id,
            package_uri="https://example.com/skill",
        )
        session.add(skill)
        shared_skill = Skill(
            name="shared-owned-skill",
            version="1",
            description="Shared skill",
            visibility="public",
            owner_agent_id=agent_id,
            package_uri="https://example.com/shared-skill",
        )
        session.add(shared_skill)
        await session.flush()
        await session.execute(
            agent_skills.insert().values(agent_id=agent_id, skill_id=skill.id)
        )
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.desired_state = "deleted"
        await session.commit()
    if fail_cleanup:
        with pytest.raises(RuntimeError, match="Synthetic client cleanup interruption"):
            await client.post(
                f"/hosted-controller/{request_id}/observation",
                headers={"Authorization": "Bearer " + TOKEN},
                json={"state": "deleted", "revision": 1},
            )
        async with factory() as session:
            assert await session.get(Agent, agent_id) is None
            pending = await session.get(HostedLaunch, (require_tenant_id(), request_id))
            assert pending.deletion_cleanup["key_id"] == key_id
    result = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "deleted", "revision": 1},
    )
    assert result.status_code == 200, result.text
    repeated = await client.post(
        f"/hosted-controller/{request_id}/observation",
        headers={"Authorization": "Bearer " + TOKEN},
        json={"state": "deleted", "revision": 1},
    )
    assert repeated.status_code == 200, repeated.text
    async with factory() as session:
        assert await session.get(Skill, skill.id) is None
        preserved = await session.get(Skill, shared_skill.id)
        assert preserved is not None
        assert preserved.owner_agent_id is None
        assert await session.get(Agent, agent_id) is None
        assert await session.get(ApiKey, key_id) is None
        assert (
            await session.scalar(
                select(HostedLaunch).where(HostedLaunch.name == "cloud-helper")
            )
            is None
        )
    result = await service.register_agent(
        name="cloud-helper",
        description="Replacement",
        connector_type="test",
        integration_profile=PROFILE,
        owner_id=launch.owner_id,
    )
    assert result.agent_id != agent_id


@pytest.mark.parametrize("cause", ["stop", "owner_loss", "disconnect", "expired"])
async def test_repository_tokens_are_revoked_after_access_commit(
    controller_app, monkeypatch, cause
):
    client, request_id, _, service, factory, _ = controller_app
    response = await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    assert response.status_code == 200, response.text
    async with factory() as session:
        record = await session.scalar(select(GitHubIssuedToken))
        assert "SYNTHETIC" not in record.encrypted_token
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        owner = launch.owner_id
        if cause == "stop":
            launch.desired_state = "stopped"
            launch.revision += 1
        elif cause == "owner_loss":
            await session.delete(
                await session.get(TenantMember, (require_tenant_id(), owner))
            )
        elif cause == "disconnect":
            await session.delete(
                await session.get(
                    ProviderConnection, (require_tenant_id(), owner, "github")
                )
            )
        else:
            record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    async def revoked(token):
        assert token == "SYNTHETIC-REPOSITORY"
        async with factory() as session:
            stored = await session.scalar(select(GitHubIssuedToken))
            assert stored.revoke_requested

    revoke = AsyncMock(side_effect=revoked)
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is False
        assert await revoke_pending(session, service.config, ()) is False
        assert await session.scalar(select(GitHubIssuedToken)) is None
    assert revoke.await_count == (0 if cause == "expired" else 1)


async def test_failed_repository_revocation_remains_queued(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as session:
        await queue_revocation(session, (GitHubIssuedToken.launch_id == request_id,))
        await session.commit()
    revoke = AsyncMock(side_effect=RuntimeError("Synthetic failure"))
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is True
        record = await session.scalar(select(GitHubIssuedToken))
        assert record.revoke_requested
        await session.commit()
        revoke.side_effect = None
        assert await revoke_pending(session, service.config, ()) is False


@pytest.mark.parametrize("action", ["stop", "remove"])
@pytest.mark.parametrize("failure", ["github", "database"])
async def test_lifecycle_commits_before_revocation_and_returns_warning(
    controller_app, monkeypatch, action, failure
):
    client, request_id, _, _, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    if action == "remove":
        async with factory() as session:
            launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
            launch.state = "stopped"
            await session.commit()

    async def fail(*args):
        async with factory() as session:
            launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
            assert launch.desired_state == (
                "deleted" if action == "remove" else "stopped"
            )
            record = await session.scalar(select(GitHubIssuedToken))
            assert record.revoke_requested
        raise RuntimeError("Synthetic cleanup failure")

    if failure == "database":
        monkeypatch.setattr(
            "switch_core.providers.github_revocations._revoke_pending", fail
        )
    else:
        monkeypatch.setattr(GitHubInstallationCredentials, "revoke", fail)
    result = await client.post(
        f"/hosted-launches/{request_id}/lifecycle",
        json={"action": action, "revision": 1},
    )
    assert result.status_code == 200, result.text
    assert "1 hour" in result.json()["access_warning"]


async def test_error_retry_issues_a_fresh_repository_token(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        launch.state = "error"
        await session.commit()
        assert await revoke_pending(session, service.config, ()) is False
        assert await session.scalar(select(GitHubIssuedToken)) is None
    assert (
        await client.post(
            f"/hosted-launches/{request_id}/lifecycle",
            json={"action": "retry", "revision": 1},
        )
    ).status_code == 200
    issue = AsyncMock(
        return_value=RepositoryCredential(
            "SYNTHETIC-FRESH-REPOSITORY",
            datetime.now(UTC) + timedelta(hours=1),
            456,
            "example/project",
        )
    )
    monkeypatch.setattr(
        "switch_core.gateway.hosted_controller.GitHubInstallationCredentials",
        lambda *_: SimpleNamespace(issue=issue, revoke=AsyncMock()),
    )
    result = await client.post(
        f"/hosted-controller/{request_id}/prepare",
        headers={"Authorization": "Bearer " + TOKEN},
    )
    assert result.status_code == 200, result.text
    assert result.json()["github_credential"] == "SYNTHETIC-FRESH-REPOSITORY"
    async with factory() as session:
        record = await session.scalar(select(GitHubIssuedToken))
        assert not record.revoke_requested
        assert record.launch_revision == 2


async def test_concurrent_revocation_drains_claim_once(controller_app, monkeypatch):
    client, request_id, _, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as session:
        await queue_revocation(session, ())
        await session.commit()
    entered, release = asyncio.Event(), asyncio.Event()

    async def revoke(token):
        entered.set()
        await release.wait()

    mocked = AsyncMock(side_effect=revoke)
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", mocked)

    async def drain():
        async with factory() as session:
            return await revoke_pending(session, service.config, ())

    first = asyncio.create_task(drain())
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await drain() is True
        async with factory() as session:
            row = await session.scalar(select(GitHubIssuedToken))
            assert row.attempts == 1
            assert row.claim_until > datetime.now(UTC) + timedelta(seconds=60)
        mocked.assert_awaited_once()
    finally:
        release.set()
    assert await first is False
    async with factory() as session:
        assert await session.scalar(select(GitHubIssuedToken)) is None


async def test_revocation_lock_timeout_preserves_committed_responses(controller_app):
    client, request_id, _, _, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as locked:
        await locked.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"github-revocation:{require_tenant_id()}"},
        )
        stopped = await client.post(
            f"/hosted-launches/{request_id}/lifecycle",
            json={"action": "stop", "revision": 1},
        )
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["desired_state"] == "stopped"
        assert stopped.json()["access_warning"]
        listed = await client.get(
            "/hosted-controller", headers={"Authorization": "Bearer " + TOKEN}
        )
        assert listed.status_code == 200, listed.text
        assert listed.json()[0]["desired_state"] == "stopped"
        await locked.rollback()
    async with factory() as session:
        row = await session.get(HostedLaunch, (require_tenant_id(), request_id))
        assert row.desired_state == "stopped"


async def test_failed_revocations_do_not_starve_newer_tokens(
    controller_app, monkeypatch
):
    client, request_id, _, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as session:
        first = await session.scalar(select(GitHubIssuedToken))
        for number in range(8):
            session.add(
                GitHubIssuedToken(
                    id=str(uuid4()),
                    owner_id=first.owner_id,
                    launch_id=request_id,
                    launch_revision=1,
                    encrypted_token=encrypt_token(
                        f"SYNTHETIC-TOKEN-{number}", service.config.jwt_secret_key
                    ),
                    expires_at=first.expires_at + timedelta(seconds=1),
                    revoke_requested=True,
                    attempts=0,
                )
            )
        first.revoke_requested = True
        await session.commit()
    seen = []

    async def fail(token):
        seen.append(token)
        raise RuntimeError("Synthetic outage")

    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", fail)
    async with factory() as session:
        assert await revoke_pending(session, service.config, ()) is True
        assert len(set(seen)) == 8
        assert await revoke_pending(session, service.config, ()) is True
    assert len(set(seen)) == 9


async def test_revocation_warning_is_scoped_to_action_owner(
    controller_app, monkeypatch
):
    client, request_id, _, service, factory, _ = controller_app
    assert (
        await client.post(
            f"/hosted-controller/{request_id}/prepare",
            headers={"Authorization": "Bearer " + TOKEN},
        )
    ).status_code == 200
    async with factory() as session:
        first = await session.scalar(select(GitHubIssuedToken))
        owner = first.owner_id
        other_user = User(
            name="other",
            email="other-revocation@example.invalid",
            role="user",
            password_hash="x",
        )
        session.add(other_user)
        await session.flush()
        other = other_user.id
        other_launch = HostedLaunch(
            id=str(uuid4()), owner_id=other, name="other-revocation-worker", spec={}
        )
        session.add(other_launch)
        await session.flush()
        session.add(
            GitHubIssuedToken(
                id=str(uuid4()),
                owner_id=other,
                launch_id=other_launch.id,
                launch_revision=1,
                encrypted_token=encrypt_token(
                    "SYNTHETIC-OTHER-TOKEN", service.config.jwt_secret_key
                ),
                expires_at=first.expires_at,
                revoke_requested=True,
                attempts=0,
            )
        )
        await session.commit()
    revoke = AsyncMock(side_effect=RuntimeError("Synthetic outage"))
    monkeypatch.setattr(GitHubInstallationCredentials, "revoke", revoke)
    async with factory() as session:
        assert (
            await revoke_pending(
                session, service.config, (GitHubIssuedToken.owner_id == owner,)
            )
            is False
        )
        revoke.assert_not_awaited()
        assert (
            await revoke_pending(
                session, service.config, (GitHubIssuedToken.owner_id == other,)
            )
            is True
        )
