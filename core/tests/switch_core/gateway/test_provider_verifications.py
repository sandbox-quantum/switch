from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI

from switch_core.crypto import decrypt_token
from switch_core.db.models import (
    ProviderConnection,
    ProviderVerification,
    TenantMember,
    User,
    require_tenant_id,
)
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import (
    get_config,
    get_session,
    get_session_factory,
)
from switch_core.gateway.provider_connections import router as connections
from switch_core.gateway.provider_verifications import router as verifications
from switch_core.providers.hosted import HostedControllerSettings
from tests.switch_core.bridges.agent.protocol.registration_harness import make_owner

CONTROLLER = "SYNTHETIC-CONTROLLER-VERIFICATION-TEST"
HEADERS = {"Authorization": "Bearer " + CONTROLLER}
KEY = "placeholder-encryption-key"


@pytest.fixture
async def verification_app(session_factory, tmp_path):
    owner = await make_owner(session_factory)
    async with session_factory() as session:
        user = await session.get(User, owner)
        session.add(
            TenantMember(tenant_id=require_tenant_id(), user_id=owner, role="member")
        )
        await session.commit()
    app = FastAPI()
    app.include_router(connections, prefix="/provider-connections")
    app.include_router(verifications)
    app.state.hosted_controller_settings = HostedControllerSettings(
        tenant_id=require_tenant_id(),
        token=CONTROLLER,
        agent_ids=[uuid4()],
        github_private_key_path=tmp_path / "unused.pem",
        agent_api_endpoint="https://switch.example.com",
    )

    async def sessions():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_session_factory] = lambda: session_factory
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(
        jwt_secret_key=KEY, hosted_provider_verification_enabled=True
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, session_factory, owner


async def start(client, provider="codex"):
    response = await client.put(
        "/provider-connections/" + provider,
        json={"kind": "api-key", "credential": "placeholder-credential"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "verifying"
    job_id = response.json()["verification_id"]
    prepared = await client.post(
        "/provider-verifications/" + job_id + "/prepare", headers=HEADERS
    )
    assert prepared.status_code == 200
    return job_id, {"Authorization": "Bearer " + prepared.json()["token"]}


async def test_verification_succeeds_before_cleanup_and_remains_queued_for_cleanup(
    verification_app,
):
    client, factory, owner = verification_app
    job_id, worker = await start(client)
    base = "/provider-verifications/" + job_id
    assert (await client.get(base + "/credential")).status_code == 403
    credential = await client.get(base + "/credential", headers=worker)
    assert credential.json()["credential"] == "placeholder-credential"
    assert credential.headers["cache-control"] == "no-store"
    async with factory() as session:
        assert (
            await session.get(ProviderConnection, (require_tenant_id(), owner, "codex"))
            is None
        )
    assert (
        await client.post(
            base + "/observe",
            headers=HEADERS,
            json={"instance_id": "i-0123456789abcdef0", "terminated": False},
        )
    ).status_code == 200
    assert (
        await client.post(
            base + "/result",
            headers=worker,
            json={"succeeded": True, "credential": "placeholder-refreshed"},
        )
    ).status_code == 200
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "connected"
    async with factory() as session:
        job = await session.get(ProviderVerification, (require_tenant_id(), job_id))
        assert job.state == "finishing"
        assert job.encrypted_credential is None and job.encrypted_token is None
        connection = await session.get(
            ProviderConnection, (require_tenant_id(), owner, "codex")
        )
        assert (
            decrypt_token(connection.encrypted_credential, KEY)
            == "placeholder-refreshed"
        )
        verified_at = connection.verified_at
        job.deadline = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    pending = (await client.get("/provider-verifications", headers=HEADERS)).json()
    assert pending[0]["id"] == job_id and pending[0]["result"] is True
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "connected"
    receipt = {"instance_id": "i-0123456789abcdef0", "terminated": True}
    assert (await client.post(base + "/observe", headers=HEADERS, json=receipt)).json()[
        "state"
    ] == "succeeded"
    assert (await client.post(base + "/observe", headers=HEADERS, json=receipt)).json()[
        "state"
    ] == "succeeded"
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "connected"
    async with factory() as session:
        connection = await session.get(
            ProviderConnection, (require_tenant_id(), owner, "codex")
        )
        assert connection.verified_at == verified_at
        assert (
            decrypt_token(connection.encrypted_credential, KEY)
            == "placeholder-refreshed"
        )
        job = await session.get(ProviderVerification, (require_tenant_id(), job_id))
        assert job.encrypted_credential is None and job.encrypted_token is None
    assert (await client.get(base + "/credential", headers=worker)).status_code == 403
    assert (await client.delete("/provider-connections/codex")).status_code == 204
    assert (await client.get("/provider-verifications", headers=HEADERS)).json() == []


async def test_timeout_denies_worker_and_never_verifies(verification_app):
    client, factory, _ = verification_app
    job_id, worker = await start(client)
    async with factory() as session:
        job = await session.get(ProviderVerification, (require_tenant_id(), job_id))
        job.deadline = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "failed"
    assert (
        await client.post(
            "/provider-verifications/" + job_id + "/result",
            headers=worker,
            json={"succeeded": True},
        )
    ).status_code == 403


async def test_deleted_connection_cannot_be_restored_by_late_result(verification_app):
    client, _, _ = verification_app
    job_id, worker = await start(client)
    base = "/provider-verifications/" + job_id
    await client.post(
        base + "/observe",
        headers=HEADERS,
        json={"instance_id": "i-0123456789abcdef0", "terminated": False},
    )
    assert (await client.delete("/provider-connections/codex")).status_code == 204
    assert (
        await client.post(base + "/result", headers=worker, json={"succeeded": True})
    ).status_code == 403
    assert (
        await client.post(
            base + "/observe",
            headers=HEADERS,
            json={"instance_id": "i-0123456789abcdef0", "terminated": True},
        )
    ).json()["state"] == "cancelled"
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "not_connected"
    assert (await client.get("/provider-verifications", headers=HEADERS)).json() == []


async def test_checks_are_bounded_and_job_tokens_are_scoped(verification_app):
    client, _, _ = verification_app
    first, worker = await start(client)
    second, _ = await start(client, "cursor")
    duplicate, _ = await start(client)
    assert duplicate == first
    assert (
        await client.get(
            "/provider-verifications/" + second + "/credential", headers=worker
        )
    ).status_code == 403
    response = await client.put(
        "/provider-connections/opencode",
        json={"kind": "auth-json", "credential": '{"example":{"key":"placeholder"}}'},
    )
    assert response.status_code == 429
    assert (await client.get("/provider-verifications")).status_code == 401


async def test_failed_replacement_preserves_verified_connection(verification_app):
    client, factory, owner = verification_app
    job_id, worker = await start(client)
    base = "/provider-verifications/" + job_id
    await client.post(base + "/result", headers=worker, json={"succeeded": True})
    await client.post(
        base + "/observe",
        headers=HEADERS,
        json={"instance_id": "i-0123456789abcdef0", "terminated": True},
    )
    second, worker = await start(client)
    base = "/provider-verifications/" + second
    await client.post(base + "/result", headers=worker, json={"succeeded": False})
    await client.post(
        base + "/observe",
        headers=HEADERS,
        json={"instance_id": "i-0123456789abcdef1", "terminated": True},
    )
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "failed"
    async with factory() as session:
        saved = await session.get(
            ProviderConnection, (require_tenant_id(), owner, "codex")
        )
        assert saved.verification_status == "verified"
        assert (
            decrypt_token(saved.encrypted_credential, KEY) == "placeholder-credential"
        )


async def test_changed_credential_cannot_silently_reuse_pending_check(verification_app):
    client, _, _ = verification_app
    await start(client)
    response = await client.put(
        "/provider-connections/codex",
        json={"kind": "api-key", "credential": "different-placeholder"},
    )
    assert response.status_code == 409


async def test_removed_member_cannot_use_verification_token(verification_app):
    client, factory, owner = verification_app
    job_id, worker = await start(client)
    async with factory() as session:
        member = await session.get(TenantMember, (require_tenant_id(), owner))
        await session.delete(member)
        await session.commit()
    base = "/provider-verifications/" + job_id
    assert (await client.get(base + "/credential", headers=worker)).status_code == 403
    assert (
        await client.post(base + "/result", headers=worker, json={"succeeded": True})
    ).status_code == 403


async def test_disconnect_after_success_keeps_cleanup_without_restoring_connection(
    verification_app,
):
    client, _, _ = verification_app
    job_id, worker = await start(client)
    base = "/provider-verifications/" + job_id
    receipt = {"instance_id": "i-0123456789abcdef0", "terminated": False}
    await client.post(base + "/observe", headers=HEADERS, json=receipt)
    await client.post(base + "/result", headers=worker, json={"succeeded": True})
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "connected"
    assert (await client.delete("/provider-connections/codex")).status_code == 204
    pending = (await client.get("/provider-verifications", headers=HEADERS)).json()
    assert pending[0]["state"] == "cancelled"
    assert pending[0]["instance_id"] == receipt["instance_id"]
    receipt["terminated"] = True
    await client.post(base + "/observe", headers=HEADERS, json=receipt)
    assert (await client.get("/provider-connections/codex")).json()[
        "status"
    ] == "not_connected"
    assert (await client.get("/provider-verifications", headers=HEADERS)).json() == []


async def test_repeated_result_cannot_replace_verified_credential(verification_app):
    client, factory, owner = verification_app
    job_id, worker = await start(client)
    base = "/provider-verifications/" + job_id
    await client.post(base + "/result", headers=worker, json={"succeeded": True})
    verified = (await client.get("/provider-connections/codex")).json()
    response = await client.post(
        base + "/result",
        headers=worker,
        json={"succeeded": True, "credential": "different-placeholder"},
    )
    assert response.status_code == 200
    assert (await client.get("/provider-connections/codex")).json() == verified
    assert (await client.get(base + "/credential", headers=worker)).status_code == 409
    async with factory() as session:
        saved = await session.get(
            ProviderConnection, (require_tenant_id(), owner, "codex")
        )
        assert (
            decrypt_token(saved.encrypted_credential, KEY) == "placeholder-credential"
        )
