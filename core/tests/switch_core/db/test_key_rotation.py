"""Boot brings every stored secret onto the current key.

Values are seeded under a legacy `JWT_SECRET_KEY` and under an older key in
`SECRET_KEYS`, in two tenants, and the sweep runs through
`rls_harness.restricted` — the role the server connects as — so it is proved to
reach every tenant's rows through the per-tenant fan-out. The stored columns
are then read back raw, as a dump would show them.
"""

from __future__ import annotations

import base64
import hashlib
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db import encrypted_json
from switch_core.db.key_rotation import reencrypt_stored_secrets
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    CollaborationBridge,
    MessagingInstall,
    ServiceConnection,
    ServiceTokenIssuance,
    Tenant,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.keys import Keyring, UndecryptableError
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_LEGACY = "legacy-jwt-secret-for-tests"
_OLD = Keyring.parse("old:" + "o" * 40, legacy_secret=_LEGACY)
_NEW = Keyring.parse("new:" + "n" * 40 + ",old:" + "o" * 40, legacy_secret=_LEGACY)


def _legacy_encrypt(plaintext: str) -> str:
    key = base64.urlsafe_b64encode(hashlib.sha256(_LEGACY.encode()).digest())
    return Fernet(key).encrypt(plaintext.encode()).decode()


async def _tenant_with_user(owner: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    suffix = uuid.uuid4().hex[:8]
    async with owner() as session:
        session.add(Tenant(id=f"tenant-{suffix}", slug=suffix, name=suffix))
        user = User(name=f"user-{suffix}", email=f"{suffix}@example.test", role="user")
        session.add(user)
        await session.commit()
        return f"tenant-{suffix}", user.id


async def _seed(
    restricted: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> dict[str, str]:
    """One of each encrypted column, the config under the old key and the two
    strings under the legacy secret. Returns their ids."""
    async with tenant_session(restricted, tenant_id) as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:switch.local",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=client.id,
            status="active",
            connection_config={"bot_token": f"xoxb-{tenant_id}"},
        )
        key = ApiKey(
            user_id=user_id,
            key_hash=uuid.uuid4().hex,
            encrypted_key=_legacy_encrypt(f"api-key-{tenant_id}"),
            label="test",
            type="user",
        )
        install = MessagingInstall(
            platform="slack",
            external_workspace_id=f"T-{tenant_id}",
            encrypted_bot_token=_legacy_encrypt(f"install-{tenant_id}"),
            scopes="chat:write",
            status="active",
            installed_by_user_id=user_id,
        )
        session.add_all([bridge, key, install])
        await session.flush()
        agent_client = Client(
            transport_user_id=f"@agent-{uuid.uuid4().hex[:8]}:switch.local",
            display_name="agent client",
            type="agent",
        )
        session.add(agent_client)
        await session.flush()
        agent = Agent(
            name=f"agent-{uuid.uuid4().hex[:8]}",
            description="",
            agent_type="session_passive",
            connector_type="external",
            integration_profile={},
            client_id=agent_client.id,
            api_key_id=key.id,
            owner_id=user_id,
        )
        connection = ServiceConnection(
            user_id=user_id,
            service="github",
            status="active",
            consent="write",
            granted_scopes=[],
            account_id="1001",
            external_identity="ada",
            encrypted_secret=_legacy_encrypt(f"service-secret-{tenant_id}"),
            secret_revision=1,
        )
        session.add_all([agent, connection])
        await session.flush()
        issuance = ServiceTokenIssuance(
            grant_id="grant",
            agent_id=agent.id,
            owner_id=user_id,
            service="github",
            principal="agent_key",
            controller_id=None,
            permissions={},
            resources={},
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            token_sha256="0" * 64,
            encrypted_token=_legacy_encrypt(f"service-token-{tenant_id}"),
            revoke_requested=False,
            attempts=0,
        )
        session.add(issuance)
        await session.commit()
        return {
            "bridge": bridge.id,
            "key": key.id,
            "install": install.id,
            "issuance": issuance.id,
            "user": user_id,
        }


async def _raw(
    owner: async_sessionmaker[AsyncSession], table: str, column: str, row_id: str
) -> object:
    async with owner() as session:
        result = await session.execute(
            text(f"SELECT {column} FROM {table} WHERE id = :id"), {"id": row_id}
        )
        return result.scalar_one()


async def _raw_where(
    owner: async_sessionmaker[AsyncSession], query: str, params: dict[str, str]
) -> object:
    async with owner() as session:
        result = await session.execute(text(query), params)
        return result.scalar_one()


async def test_every_tenants_secrets_end_up_under_the_current_key(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(encrypted_json, "_keyring", _OLD)
    seeded = {}
    for _ in range(2):
        tenant_id, user_id = await _tenant_with_user(rls_harness.owner)
        seeded[tenant_id] = await _seed(rls_harness.restricted, tenant_id, user_id)

    monkeypatch.setattr(encrypted_json, "_keyring", _NEW)
    await reencrypt_stored_secrets(rls_harness.restricted, _NEW, list(seeded))

    current = _NEW.current_prefix()
    for tenant_id, ids in seeded.items():
        config = await _raw(
            rls_harness.owner,
            "collaboration_bridges",
            "connection_config",
            ids["bridge"],
        )
        assert isinstance(config, dict) and config["_enc"].startswith(current)
        assert _NEW.decrypt(config["_enc"]) == f'{{"bot_token": "xoxb-{tenant_id}"}}'

        key = await _raw(rls_harness.owner, "api_keys", "encrypted_key", ids["key"])
        assert isinstance(key, str) and key.startswith(current)
        assert _NEW.decrypt(key) == f"api-key-{tenant_id}"

        token = await _raw(
            rls_harness.owner,
            "messaging_installs",
            "encrypted_bot_token",
            ids["install"],
        )
        assert isinstance(token, str) and token.startswith(current)
        assert _NEW.decrypt(token) == f"install-{tenant_id}"

        secret = await _raw_where(
            rls_harness.owner,
            "SELECT encrypted_secret FROM service_connections "
            "WHERE tenant_id = :tenant AND user_id = :user",
            {"tenant": tenant_id, "user": ids["user"]},
        )
        assert isinstance(secret, str) and secret.startswith(current)
        assert _NEW.decrypt(secret) == f"service-secret-{tenant_id}"

        issued = await _raw(
            rls_harness.owner,
            "service_token_issuances",
            "encrypted_token",
            ids["issuance"],
        )
        assert isinstance(issued, str) and issued.startswith(current)
        assert _NEW.decrypt(issued) == f"service-token-{tenant_id}"

    # Once done, nothing needs the old key or the legacy secret any more.
    without_old = Keyring.parse("new:" + "n" * 40, legacy_secret=None)
    for ids in seeded.values():
        key = await _raw(rls_harness.owner, "api_keys", "encrypted_key", ids["key"])
        assert isinstance(key, str)
        without_old.decrypt(key)


async def test_the_deployments_registered_clients_end_up_under_the_current_key(
    rls_harness: RLSHarness,
) -> None:
    """A client Core registered at a vendor belongs to no tenant, and is
    rewritten once whatever the tenants, by the runtime role."""
    async with rls_harness.owner() as session:
        await session.execute(
            text(
                "INSERT INTO service_oauth_clients "
                "(service, registration_endpoint, client_id, encrypted_secret) "
                "VALUES ('example', 'https://auth.example.test/register', "
                "'registered-1', :secret)"
            ),
            {"secret": _legacy_encrypt('{"client_id": "registered-1"}')},
        )
        await session.commit()

    await reencrypt_stored_secrets(rls_harness.restricted, _NEW, [])

    secret = await _raw_where(
        rls_harness.owner,
        "SELECT encrypted_secret FROM service_oauth_clients WHERE service = :service",
        {"service": "example"},
    )
    assert isinstance(secret, str) and secret.startswith(_NEW.current_prefix())
    assert _NEW.decrypt(secret) == '{"client_id": "registered-1"}'


async def test_a_value_no_key_opens_stops_the_boot(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A key removed before its values were re-encrypted. Carrying on would
    leave a credential nothing can read while reporting the rotation done."""
    monkeypatch.setattr(encrypted_json, "_keyring", _OLD)
    tenant_id, user_id = await _tenant_with_user(rls_harness.owner)
    await _seed(rls_harness.restricted, tenant_id, user_id)

    too_early = Keyring.parse("new:" + "n" * 40, legacy_secret=None)
    monkeypatch.setattr(encrypted_json, "_keyring", too_early)
    with pytest.raises(UndecryptableError):
        await reencrypt_stored_secrets(rls_harness.restricted, too_early, [tenant_id])


async def test_a_hash_only_key_is_left_alone(
    rls_harness: RLSHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Controller credentials and enrollment codes keep only a hash, so their
    `encrypted_key` is the empty string. Boot must not try to open it."""
    monkeypatch.setattr(encrypted_json, "_keyring", _NEW)
    tenant_id, user_id = await _tenant_with_user(rls_harness.owner)
    async with tenant_session(rls_harness.restricted, tenant_id) as session:
        key = ApiKey(
            user_id=user_id,
            key_hash=uuid.uuid4().hex,
            encrypted_key="",
            label="controller",
            type="user",
        )
        session.add(key)
        await session.commit()
        key_id = key.id

    await reencrypt_stored_secrets(rls_harness.restricted, _NEW, [tenant_id])

    assert await _raw(rls_harness.owner, "api_keys", "encrypted_key", key_id) == ""
