"""Each organization's Switch Trust policy, against Postgres.

Every assertion goes through `rls_harness.restricted`, the role the policies
apply to; `owner` only arranges fixtures.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Organization, Tenant, User
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_trust_settings_store import (
    OrganizationTrustSettingsStore,
)
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant

STORE = OrganizationTrustSettingsStore()


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _organization(owner: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    """An organization with one workspace."""
    organization_id, tenant_id = _id("org"), _id("tenant")
    async with owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="O"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id, slug=tenant_id, name="W", organization_id=organization_id
            )
        )
        await session.commit()
    return organization_id, tenant_id


async def _user(owner: async_sessionmaker[AsyncSession]) -> str:
    async with owner() as session:
        user = User(name="admin", email=f"{_id('admin')}@example.invalid", role="user")
        session.add(user)
        await session.commit()
        return user.id


async def _connect(
    session: AsyncSession, organization_id: str, user_id: str, policy_id: str
) -> None:
    await STORE.save(
        session,
        organization_id=organization_id,
        endpoint="https://trust.example",
        policy_id=policy_id,
        policy_name="Baseline",
        api_key_encrypted="enc:key",
        updated_by=user_id,
    )
    await session.commit()


async def test_a_workspace_reads_its_own_organizations_policy_and_no_other(
    rls_harness: RLSHarness,
) -> None:
    ours, our_workspace = await _organization(rls_harness.owner)
    theirs, their_workspace = await _organization(rls_harness.owner)
    admin = await _user(rls_harness.owner)
    async with organization_session(rls_harness.restricted, ours) as session:
        await _connect(session, ours, admin, "pol_ours")
    async with organization_session(rls_harness.restricted, theirs) as session:
        await _connect(session, theirs, admin, "pol_theirs")

    async with tenant_session(rls_harness.restricted, our_workspace) as session:
        organization = await STORE.organization_of(session, our_workspace)
        own = await STORE.get(session, ours)
        other = await STORE.get(session, theirs)

    assert organization == ours
    assert own is not None and own.policy_id == "pol_ours"
    assert other is None


async def test_connecting_again_replaces_the_policy(rls_harness: RLSHarness) -> None:
    organization_id, workspace = await _organization(rls_harness.owner)
    admin = await _user(rls_harness.owner)
    async with organization_session(rls_harness.restricted, organization_id) as s:
        await _connect(s, organization_id, admin, "pol_1")
        first = await STORE.get(s, organization_id)
        assert first is not None
        connected_at = first.updated_at
        await _connect(s, organization_id, admin, "pol_2")

    async with tenant_session(rls_harness.restricted, workspace) as session:
        settings = await STORE.get(session, organization_id)

    assert settings is not None
    assert settings.policy_id == "pol_2"
    assert settings.updated_at >= connected_at


async def test_clearing_disconnects_it(rls_harness: RLSHarness) -> None:
    organization_id, _ = await _organization(rls_harness.owner)
    admin = await _user(rls_harness.owner)
    async with organization_session(rls_harness.restricted, organization_id) as s:
        await _connect(s, organization_id, admin, "pol_1")
        await STORE.clear(s, organization_id)
        await s.commit()
        assert await STORE.get(s, organization_id) is None
