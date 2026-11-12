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


async def _organization(session_factory, workos_organization_id: str | None) -> str:
    organization_id = _id("org")
    async with session_factory() as session:
        session.add(
            Organization(
                id=organization_id,
                slug=organization_id,
                name="Acme",
                workos_organization_id=workos_organization_id,
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


async def _member(session_factory, organization_id: str, user_id: str, role: str):
    async with session_factory() as session:
        session.add(
            OrganizationMember(
                organization_id=organization_id, user_id=user_id, role=role
            )
        )
        await session.commit()


async def _recorded(
    session_factory, organization_id: str, action: OrganizationAuditAction
) -> list[OrganizationAuditEvent]:
    async with session_factory() as session:
        return list(
            await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.organization_id == organization_id,
                    OrganizationAuditEvent.action == action,
                )
            )
        )


async def _added(session_factory, organization_id: str) -> list[OrganizationAuditEvent]:
    return await _recorded(
        session_factory,
        organization_id,
        OrganizationAuditAction.MEMBER_ADDED_FROM_DIRECTORY,
    )


class TestBringingInMemberships:
    async def test_adds_them_with_the_directorys_role_and_records_it(
        self, rls_harness: RLSHarness
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        linked = _id("org_workos")
        organization_id = await _organization(session_factory, linked)
        ada = await _person(session_factory)

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(linked, "org_admin")]
        )
        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(linked, "org_admin")]
        )

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        [event] = await _added(session_factory, organization_id)
        assert event.actor_user_id is None
        assert event.target_id == ada
        assert event.details == {"source": "sign_in", "role": "org_admin"}

    async def test_only_the_linked_organization_counts(
        self, rls_harness: RLSHarness
    ) -> None:
        """An `org_admin` of some other WorkOS organization (another product's,
        beneath the same customer, or one claiming the customer in its
        metadata) is nothing in the linked organization."""
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        organization_id = await _organization(session_factory, _id("org_workos"))
        ada = await _person(session_factory)

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(_id("org_elsewhere"), "org_admin")]
        )

        assert await _role(session_factory, organization_id, ada) is None

    async def test_an_organization_nobody_linked_is_left_alone(
        self, rls_harness: RLSHarness
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        organization_id = await _organization(session_factory, None)
        ada = await _person(session_factory)
        await _member(session_factory, organization_id, ada, "member")

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(_id("org_workos"), "org_admin")]
        )

        assert await _role(session_factory, organization_id, ada) == "member"

    async def test_a_member_made_org_admin_is_promoted_and_it_is_recorded(
        self, rls_harness: RLSHarness
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        linked = _id("org_workos")
        organization_id = await _organization(session_factory, linked)
        ada = await _person(session_factory)
        await _member(session_factory, organization_id, ada, "member")

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(linked, "org_admin")]
        )

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        [event] = await _recorded(
            session_factory,
            organization_id,
            OrganizationAuditAction.MEMBER_PROMOTED_FROM_DIRECTORY,
        )
        assert event.target_id == ada
        assert event.details == {
            "source": "sign_in",
            "from_role": "member",
            "role": "org_admin",
        }

    async def test_a_demotion_is_left_for_the_mirror_and_logged(
        self, rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Taking a role away takes away what it reached, which is not a
        sign-in's to do."""
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        linked = _id("org_workos")
        organization_id = await _organization(session_factory, linked)
        ada = await _person(session_factory)
        await _member(session_factory, organization_id, ada, "org_admin")

        await bring_in_memberships(
            restricted, ada, [DirectoryMembership(linked, "member")]
        )

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        assert await _added(session_factory, organization_id) == []
        [record] = [r for r in caplog.records if "mirror applies it" in r.message]
        assert record.levelname == "WARNING"

    async def test_a_membership_no_longer_listed_is_left_for_the_mirror(
        self, rls_harness: RLSHarness, caplog: pytest.LogCaptureFixture
    ) -> None:
        session_factory, restricted = rls_harness.owner, rls_harness.restricted
        organization_id = await _organization(session_factory, _id("org_workos"))
        ada = await _person(session_factory)
        await _member(session_factory, organization_id, ada, "org_admin")

        await bring_in_memberships(restricted, ada, [])

        assert await _role(session_factory, organization_id, ada) == "org_admin"
        [record] = [r for r in caplog.records if "mirror applies it" in r.message]
        assert record.levelname == "WARNING"
