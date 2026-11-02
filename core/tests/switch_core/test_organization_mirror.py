"""A person's organization memberships brought up to date at sign-in from a
directory kept outside Switch, against Postgres, on the restricted role
row-level security applies to; `owner` only arranges fixtures and reads
results."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from switch_core.db.audit import OrganizationAuditAction
from switch_core.db.models import (
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    User,
)
from switch_core.organization_directory import DirectoryMembership
from switch_core.organization_mirror import bring_in_memberships
from tests.conftest import RLSHarness

pytestmark = pytest.mark.no_ambient_tenant


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _organization(session_factory, customer_id: str | None) -> str:
    organization_id = _id("org")
    async with session_factory() as session:
        session.add(
            Organization(
                id=organization_id,
                slug=organization_id,
                name="Acme",
                customer_id=customer_id,
            )
        )
        await session.commit()
    return organization_id


async def _person(session_factory) -> str:
    user_id = _id("user")
    async with session_factory() as session:
        session.add(
            User(
                id=user_id,
                name=user_id,
                email=f"{user_id}@example.invalid",
                role="user",
            )
        )
        await session.commit()
    return user_id


async def _role(session_factory, organization_id: str, user_id: str) -> str | None:
    async with session_factory() as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
    return None if member is None else member.role


async def _added(session_factory, organization_id: str) -> list[OrganizationAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id,
                    OrganizationAuditEvent.action
                    == OrganizationAuditAction.MEMBER_ADDED_AT_SIGN_IN,
                )
            )
        )


class TestBringingInMemberships:
    async def test_adds_them_with_the_directorys_role_and_records_it(
        self, rls_harness: RLSHarness
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        customer = _id("ten")
        organization_id = await _organization(session_factory, customer)
        ada = await _person(session_factory)

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(customer, "org_admin")]
        )
        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(customer, "org_admin")]
        )

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        [event] = await _added(session_factory, organization_id)
        assert event.actor_user_id is None
        assert event.target_id == ada
        assert event.details == {"role": "org_admin"}

    async def test_a_customer_with_no_switch_organization_is_left_alone(
        self, rls_harness: RLSHarness
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        ada = await _person(session_factory)

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(_id("ten"), "member")]
        )

        async with session_factory() as session:
            assert (
                await session.scalars(
                    select(OrganizationMember).where(OrganizationMember.user_id == ada)
                )
            ).all() == []

    async def test_a_role_that_differs_is_left_and_logged(
        self, rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Taking a role away takes away what it reached, which is not a
        sign-in's to do."""
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        customer = _id("ten")
        organization_id = await _organization(session_factory, customer)
        ada = await _person(session_factory)
        async with session_factory() as session:
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=ada, role="org_admin"
                )
            )
            await session.commit()

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(customer, "member")]
        )

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        assert await _added(session_factory, organization_id) == []
        assert "leaves Switch's role as it is" in caplog.text
