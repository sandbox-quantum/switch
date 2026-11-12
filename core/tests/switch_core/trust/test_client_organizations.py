"""`DynamicTrustClient` against Postgres, through the role row-level security
applies to: a message is checked against its own workspace's organization's
policy and never another's, and a workspace whose organization connected none
is not checked."""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Organization, OrganizationTrustSettings, Tenant
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)
from switch_core.trust.client import DynamicTrustClient
from tests.conftest import TEST_KEYRING, RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


async def _workspace(
    owner: async_sessionmaker[AsyncSession], policy_id: str | None
) -> str:
    """A workspace in an organization of its own, which connected
    `policy_id`, or nothing when it is None."""
    organization_id = f"org-{uuid.uuid4().hex[:8]}"
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="O"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name="W", organization_id=organization_id
            )
        )
        if policy_id is not None:
            session.add(
                OrganizationTrustSettings(
                    organization_id=organization_id,
                    endpoint="https://trust.example",
                    policy_id=policy_id,
                    api_key_encrypted=TEST_KEYRING.encrypt(f"key-for-{policy_id}"),
                )
            )
        await session.commit()
    return tenant_id


async def test_each_message_is_checked_against_its_own_organizations_policy(
    rls_harness: RLSHarness,
) -> None:
    asked: list[tuple[str | None, str | None]] = []

    def switch_trust(request: httpx.Request) -> httpx.Response:
        asked.append(
            (
                request.headers.get("x-guardrails-policy-id"),
                request.headers.get("x-flintai-api-key"),
            )
        )
        return httpx.Response(200, json={"outcome": "GUARDRAIL_RESULT_OUTCOME_OK"})

    acme = await _workspace(rls_harness.owner, "pol_acme")
    globex = await _workspace(rls_harness.owner, "pol_globex")
    unchecked = await _workspace(rls_harness.owner, None)
    client = DynamicTrustClient(
        session_factory=rls_harness.restricted,
        store=OrganizationTrustSettingsStore(),
        keyring=TEST_KEYRING,
        client=httpx.AsyncClient(transport=httpx.MockTransport(switch_trust)),
        timeout_seconds=1.0,
    )

    for tenant_id in (acme, globex, unchecked):
        await client.check(
            tenant_id=tenant_id, role="user", content="hi", room_id="room-1"
        )

    assert asked == [
        ("pol_acme", "key-for-pol_acme"),
        ("pol_globex", "key-for-pol_globex"),
    ]
    assert await client.is_active(unchecked) is False
