from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from switch_core.crypto import decrypt_token
from switch_core.db.models import ProviderConnection, Tenant, User
from switch_core.db.stores.provider_connection_store import ProviderConnectionStore
from switch_core.gateway.auth import get_current_user
from switch_core.gateway.dependencies import get_config, get_session
from switch_core.gateway.provider_connections import router
from switch_core.providers.claude_verifier import ClaudeVerificationError
from switch_core.tenant_context import tenant_scope


@pytest.fixture
async def connection_app(session_factory):
    async with session_factory() as session:
        first = User(
            id="first",
            name="First",
            email="first@example.com",
            role="user",
            password_hash="unused",
        )
        second = User(
            id="second",
            name="Second",
            email="second@example.com",
            role="user",
            password_hash="unused",
        )
        session.add_all([first, second, Tenant(id="other", slug="other", name="Other")])
        await session.commit()
    identity = {"user": first}
    app = FastAPI()
    app.include_router(router, prefix="/provider-connections")
    verifier = AsyncMock()
    app.state.claude_verifier = verifier

    async def sessions():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_session] = sessions
    app.dependency_overrides[get_current_user] = lambda: identity["user"]
    app.dependency_overrides[get_config] = lambda: SimpleNamespace(
        jwt_secret_key="synthetic-encryption-test-key"
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://switch.example.com"
    ) as client:
        yield client, identity, verifier, session_factory, app


async def test_save_is_encrypted_scoped_and_survives_new_request(connection_app):
    client, identity, verifier, factory, _ = connection_app
    credential = "sk-ant-api-SYNTHETIC-PLACEHOLDER"
    response = await client.put(
        "/provider-connections/claude",
        json={"kind": "api-key", "credential": credential},
    )
    assert response.status_code == 200
    assert credential not in response.text
    verifier.verify.assert_awaited_once_with("api-key", credential)
    async with factory() as session:
        row = await ProviderConnectionStore().get(session, "first")
        assert row.encrypted_credential != credential
        assert (
            decrypt_token(row.encrypted_credential, "synthetic-encryption-test-key")
            == credential
        )
    assert (await client.get("/provider-connections/claude")).json()[
        "status"
    ] == "connected"
    identity["user"] = SimpleNamespace(id="second")
    assert (await client.get("/provider-connections/claude")).json() == {
        "status": "not_connected"
    }
    await client.delete("/provider-connections/claude")
    identity["user"] = SimpleNamespace(id="first")
    with tenant_scope("other"):
        assert (await client.get("/provider-connections/claude")).json() == {
            "status": "not_connected"
        }
        await client.delete("/provider-connections/claude")
    assert (await client.get("/provider-connections/claude")).json()[
        "status"
    ] == "connected"
    assert (await client.delete("/provider-connections/claude")).status_code == 204
    assert (await client.get("/provider-connections/claude")).json()[
        "status"
    ] == "not_connected"


async def test_failed_replacement_preserves_previous_connection(connection_app):
    client, _, verifier, _, _ = connection_app
    assert (
        await client.put(
            "/provider-connections/claude",
            json={
                "kind": "setup-token",
                "credential": "sk-ant-oat-SYNTHETIC-PLACEHOLDER",
            },
        )
    ).status_code == 200
    verifier.verify.side_effect = ClaudeVerificationError(
        "Claude could not complete the check."
    )
    result = await client.put(
        "/provider-connections/claude",
        json={"kind": "api-key", "credential": "sk-ant-api-SYNTHETIC-REPLACEMENT"},
    )
    assert result.status_code == 422
    assert "SYNTHETIC" not in result.text
    assert (await client.get("/provider-connections/claude")).json()[
        "kind"
    ] == "setup-token"


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "wrong", "credential": "PRIVATE-PLACEHOLDER"},
        {"kind": "api-key", "credential": "sk-ant-oat-PRIVATE-PLACEHOLDER"},
        {"kind": "setup-token", "credential": ["PRIVATE-PLACEHOLDER"]},
        {"kind": "api-key", "credential": "sk-ant-api-PRIVATE PLACEHOLDER"},
    ],
)
async def test_bad_input_never_echoes_secret(connection_app, body):
    client, _, verifier, _, _ = connection_app
    result = await client.put("/provider-connections/claude", json=body)
    assert result.status_code == 400
    assert "PRIVATE" not in result.text
    verifier.verify.assert_not_awaited()


async def test_disabled_verifier_and_oversize_body(connection_app):
    client, _, _, _, app = connection_app
    result = await client.put("/provider-connections/claude", content="x" * 21000)
    assert result.status_code == 413
    app.state.claude_verifier = None
    assert (await client.get("/provider-connections/claude")).status_code == 503


async def test_provider_table_enforces_rls(rls_harness):
    async with rls_harness.owner() as session:
        session.add_all(
            [
                User(
                    id="owner",
                    name="Owner",
                    email="owner@example.com",
                    role="user",
                    password_hash="unused",
                ),
                Tenant(id="tenant-a", slug="tenant-a", name="A"),
                Tenant(id="tenant-b", slug="tenant-b", name="B"),
            ]
        )
        await session.commit()
    with tenant_scope("tenant-a"):
        async with rls_harness.restricted() as session:
            await ProviderConnectionStore().save(
                session, "owner", "api-key", "synthetic-ciphertext", datetime.now(UTC)
            )
            await session.commit()
    with tenant_scope("tenant-b"):
        async with rls_harness.restricted() as session:
            assert (
                await session.execute(select(ProviderConnection))
            ).scalars().all() == []


async def test_simultaneous_connection_changes_fail_without_waiting(connection_app):
    client, _, verifier, factory, _ = connection_app
    async with factory() as session:
        await ProviderConnectionStore().lock_user(session, "first")
        result = await client.put(
            "/provider-connections/claude",
            json={"kind": "api-key", "credential": "sk-ant-api-SYNTHETIC-PLACEHOLDER"},
        )
        assert result.status_code == 409
        assert (await client.delete("/provider-connections/claude")).status_code == 409
        verifier.verify.assert_not_awaited()
