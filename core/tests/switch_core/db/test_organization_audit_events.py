"""An organization's audit log: written from any of its workspaces, read only
within the organization, and append-only for the role the server connects as.
Every assertion goes through `rls_harness.restricted`, the role the policies
apply to; `owner` only arranges fixtures."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.audit import (
    OrganizationAuditAction,
    list_organization_audit_events,
    record_organization_audit_event,
)
from switch_core.db.models import Organization, OrganizationAuditEvent, Tenant
from switch_core.db.session_scope import organization_session, tenant_session
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


async def _organization(owner: async_sessionmaker[AsyncSession]) -> tuple[str, str]:
    """An organization with one workspace: (organization id, workspace id)."""
    organization_id = f"org-{uuid.uuid4().hex[:8]}"
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with owner() as session:
        session.add(Organization(id=organization_id, slug=organization_id, name="O"))
        await session.flush()
        session.add(
            Tenant(
                id=tenant_id,
                slug=tenant_id,
                name="W",
                organization_id=organization_id,
            )
        )
        await session.commit()
    return organization_id, tenant_id


async def _record(
    restricted: async_sessionmaker[AsyncSession], organization_id: str, tenant_id: str
) -> None:
    async with tenant_session(restricted, tenant_id) as session:
        await record_organization_audit_event(
            session,
            organization_id=organization_id,
            actor_user_id="ada",
            action=OrganizationAuditAction.ROLE_CHANGED,
            target_type="user",
            target_id="bob",
            details={"from": "member", "to": "org_admin"},
        )
        await session.commit()


async def test_written_from_a_workspace_and_read_only_within_its_organization(
    rls_harness: RLSHarness,
) -> None:
    org_a, tenant_a = await _organization(rls_harness.owner)
    org_b, tenant_b = await _organization(rls_harness.owner)
    await _record(rls_harness.restricted, org_a, tenant_a)

    async with organization_session(rls_harness.restricted, org_a) as session:
        [event] = await list_organization_audit_events(
            session, organization_id=org_a, limit=10, before=None
        )
    async with tenant_session(rls_harness.restricted, tenant_b) as session:
        seen_from_b = (await session.scalars(select(OrganizationAuditEvent))).all()

    assert (event.actor_user_id, event.target_id) == ("ada", "bob")
    assert seen_from_b == []


async def test_a_workspace_cannot_write_into_another_organization(
    rls_harness: RLSHarness,
) -> None:
    org_a, _ = await _organization(rls_harness.owner)
    _, tenant_b = await _organization(rls_harness.owner)

    with pytest.raises(ProgrammingError, match="row-level security"):
        await _record(rls_harness.restricted, org_a, tenant_b)


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE organization_audit_events SET action = 'rewritten'",
        "DELETE FROM organization_audit_events",
    ],
)
async def test_the_runtime_role_cannot_rewrite_history(
    rls_harness: RLSHarness, statement: str
) -> None:
    organization_id, tenant_id = await _organization(rls_harness.owner)
    await _record(rls_harness.restricted, organization_id, tenant_id)

    async with tenant_session(rls_harness.restricted, tenant_id) as session:
        with pytest.raises(ProgrammingError, match="permission denied"):
            await session.execute(text(statement))

    async with rls_harness.owner() as session:
        [event] = (
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id
                )
            )
        ).all()
    assert event.action == OrganizationAuditAction.ROLE_CHANGED
