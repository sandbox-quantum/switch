"""Connection configs are encrypted at rest, and plaintext ones are converted.

A bridge's connection config carries the platform credentials the server acts
with. These tests read the stored column back with raw SQL — what a database
dump or a stray read-only grant would show — and assert the credential is not
in it, while the application still reads the dict it wrote.

The boot conversion runs through `rls_harness.restricted`, the role the server
connects as, so it is proved to reach every tenant's rows through the
per-tenant fan-out rather than through an owner connection's policy exemption.
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db import encrypted_json
from switch_core.db.key_rotation import reencrypt_stored_secrets
from switch_core.db.models import Client, CollaborationBridge, Tenant
from switch_core.db.session_scope import tenant_session
from tests.conftest import TEST_KEYRING, RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

_SECRET_VALUE = "placeholder-bot-token-for-tests"


async def _make_tenant(session_factory: async_sessionmaker[AsyncSession]) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with session_factory() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.commit()
    return tenant_id


async def _make_bridge(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    config: dict[str, str],
) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
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
            connection_config=config,
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


async def _raw_config(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> object:
    async with session_factory() as session:
        result = await session.execute(
            text("SELECT connection_config FROM collaboration_bridges WHERE id = :id"),
            {"id": bridge_id},
        )
        return result.scalar_one()


async def _read_config(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, bridge_id: str
) -> dict | None:
    async with tenant_session(session_factory, tenant_id) as session:
        bridge = (
            await session.execute(
                select(CollaborationBridge).where(CollaborationBridge.id == bridge_id)
            )
        ).scalar_one()
        return bridge.connection_config


async def test_a_written_config_is_stored_encrypted_and_reads_back(
    rls_harness: RLSHarness,
) -> None:
    tenant = await _make_tenant(rls_harness.owner)
    config = {"bot_token": _SECRET_VALUE, "workspace": "example"}

    bridge_id = await _make_bridge(rls_harness.restricted, tenant, config)

    raw = await _raw_config(rls_harness.owner, bridge_id)
    assert encrypted_json.is_encrypted(raw)
    assert _SECRET_VALUE not in json.dumps(raw)
    assert await _read_config(rls_harness.restricted, tenant, bridge_id) == config


async def test_boot_encrypts_every_tenants_plaintext_configs(
    rls_harness: RLSHarness,
) -> None:
    tenant_a = await _make_tenant(rls_harness.owner)
    tenant_b = await _make_tenant(rls_harness.owner)
    config_a = {"bot_token": f"{_SECRET_VALUE}-a"}
    config_b = {"bot_token": f"{_SECRET_VALUE}-b"}
    bridge_a = await _make_bridge(rls_harness.owner, tenant_a, config_a)
    bridge_b = await _make_bridge(rls_harness.owner, tenant_b, config_b)
    # What a row written before encryption existed looks like.
    async with rls_harness.owner() as session:
        for bridge_id, config in ((bridge_a, config_a), (bridge_b, config_b)):
            await session.execute(
                text(
                    "UPDATE collaboration_bridges "
                    "SET connection_config = CAST(:config AS jsonb) WHERE id = :id"
                ),
                {"config": json.dumps(config), "id": bridge_id},
            )
        await session.commit()
    assert await _read_config(rls_harness.restricted, tenant_a, bridge_a) == config_a

    await reencrypt_stored_secrets(
        rls_harness.restricted, TEST_KEYRING, [tenant_a, tenant_b]
    )

    for tenant, bridge_id, config in (
        (tenant_a, bridge_a, config_a),
        (tenant_b, bridge_b, config_b),
    ):
        raw = await _raw_config(rls_harness.owner, bridge_id)
        assert encrypted_json.is_encrypted(raw)
        assert config["bot_token"] not in json.dumps(raw)
        assert await _read_config(rls_harness.restricted, tenant, bridge_id) == config


async def test_boot_conversion_leaves_encrypted_and_empty_configs_alone(
    rls_harness: RLSHarness,
) -> None:
    tenant = await _make_tenant(rls_harness.owner)
    encrypted_id = await _make_bridge(
        rls_harness.owner, tenant, {"bot_token": _SECRET_VALUE}
    )
    before = await _raw_config(rls_harness.owner, encrypted_id)
    async with tenant_session(rls_harness.restricted, tenant) as session:
        empty = CollaborationBridge(
            type="slack",
            display_name="Empty",
            client_id=(
                await session.execute(
                    select(CollaborationBridge.client_id).where(
                        CollaborationBridge.id == encrypted_id
                    )
                )
            ).scalar_one(),
            status="active",
            connection_config=None,
        )
        session.add(empty)
        await session.commit()
        empty_id = empty.id

    async with tenant_session(rls_harness.restricted, tenant) as session:
        rewritten = await encrypted_json.reencrypt_stale_values(
            session, CollaborationBridge, "connection_config"
        )
        await session.commit()

    assert rewritten == 0
    assert await _raw_config(rls_harness.owner, encrypted_id) == before
    assert await _raw_config(rls_harness.owner, empty_id) is None
