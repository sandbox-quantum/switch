"""Row-level security on the organization boundary, through the restricted role.

`organizations` and `organization_members` are compared against
`require_organization_id()` (`db/rls_ddl.py`), which answers from the bound
workspace when there is one and from an explicitly bound organization when
there is not. Every assertion here goes through `rls_harness.restricted`,
the role the policies apply to; `owner` only arranges fixtures.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Organization, OrganizationMember, Tenant, User
from switch_core.db.session_scope import organization_session, tenant_session
from switch_core.db.stores.organization_store import OrganizationStore
from switch_core.db.stores.user_store import UserStore
from switch_core.db.tenant_session import TenantBindingDriftError
from switch_core.tenant_context import organization_scope
from tests.conftest import RLSHarness


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


async def _make_organization(
    owner: async_sessionmaker[AsyncSession], *, members: dict[str, str]
) -> tuple[str, str]:
    """An organization with one workspace and `members` (user id -> role)."""
    organization_id, tenant_id = _id("org"), _id("tenant")
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
        for user_id, role in members.items():
            if await session.get(User, user_id) is None:
                session.add(
                    User(
                        id=user_id,
                        name=user_id,
                        email=f"{user_id}@example.com",
                        role="user",
                    )
                )
                await session.flush()
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=user_id, role=role
                )
            )
        await session.commit()
    return organization_id, tenant_id


async def _visible_members(session: AsyncSession) -> set[tuple[str, str]]:
    rows = await session.execute(
        select(OrganizationMember.organization_id, OrganizationMember.user_id)
    )
    return {(row.organization_id, row.user_id) for row in rows}


class TestReads:
    async def test_a_workspace_session_sees_its_own_organization_only(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, tenant_a = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )
        org_b, _ = await _make_organization(
            rls_harness.owner, members={"bob": "org_admin"}
        )

        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            organizations = set((await session.scalars(select(Organization.id))).all())
            members = await _visible_members(session)

        assert organizations == {org_a}
        assert members == {(org_a, "ada")}
        assert org_b not in organizations

    async def test_an_organization_session_sees_that_organization_only(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, _ = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )
        await _make_organization(rls_harness.owner, members={"bob": "member"})

        async with organization_session(rls_harness.restricted, org_a) as session:
            members = await _visible_members(session)

        assert members == {(org_a, "ada")}

    async def test_nothing_bound_is_refused(self, rls_harness: RLSHarness) -> None:
        await _make_organization(rls_harness.owner, members={"ada": "org_admin"})

        async with rls_harness.restricted() as session:
            with pytest.raises(DBAPIError, match="neither app.organization_id"):
                await _visible_members(session)

    async def test_another_organization_inside_a_workspace_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        _, tenant_a = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )
        org_b, _ = await _make_organization(
            rls_harness.owner, members={"bob": "org_admin"}
        )

        with organization_scope(org_b):
            async with tenant_session(rls_harness.restricted, tenant_a) as session:
                with pytest.raises(DBAPIError, match="not the bound workspace"):
                    await _visible_members(session)

    async def test_a_workspace_without_an_organization_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        tenant_id = _id("tenant")
        async with rls_harness.owner() as session:
            session.add(Tenant(id=tenant_id, slug=tenant_id, name="Legacy"))
            await session.commit()

        async with tenant_session(rls_harness.restricted, tenant_id) as session:
            with pytest.raises(DBAPIError, match="belongs to no organization"):
                await _visible_members(session)


class TestWrites:
    async def test_a_member_cannot_be_written_into_another_organization(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, _ = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )
        org_b, _ = await _make_organization(
            rls_harness.owner, members={"bob": "org_admin"}
        )

        async with organization_session(rls_harness.restricted, org_a) as session:
            session.add(
                OrganizationMember(organization_id=org_b, user_id="ada", role="member")
            )
            with pytest.raises(DBAPIError, match="row-level security"):
                await session.flush()

    async def test_an_organization_is_created_under_its_own_binding(
        self, rls_harness: RLSHarness
    ) -> None:
        organization = Organization(id=_id("org"), slug=_id("slug"), name="New")

        async with organization_session(
            rls_harness.restricted, organization.id
        ) as session:
            await OrganizationStore().create(session, organization)
            await session.commit()

        async with organization_session(
            rls_harness.restricted, organization.id
        ) as session:
            found = await session.scalar(select(Organization.name))
        assert found == "New"

    async def test_binding_an_organization_inside_an_open_transaction_is_refused(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, _ = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )

        async with organization_session(rls_harness.restricted, org_a) as session:
            await _visible_members(session)
            with organization_scope(_id("org")):
                with pytest.raises(TenantBindingDriftError):
                    await _visible_members(session)


class TestJoiningAWorkspaceJoinsItsOrganization:
    async def test_a_new_member_joins_as_the_role_given_and_keeps_an_existing_one(
        self, rls_harness: RLSHarness
    ) -> None:
        org_a, tenant_a = await _make_organization(
            rls_harness.owner, members={"ada": "org_admin"}
        )
        async with rls_harness.owner() as session:
            session.add(User(id="cy", name="cy", email="cy@example.com", role="user"))
            await session.commit()

        store = UserStore()
        async with tenant_session(rls_harness.restricted, tenant_a) as session:
            await store.add_membership(
                session,
                tenant_id=tenant_a,
                user_id="cy",
                role="admin",
                organization_role="member",
            )
            await store.add_membership(
                session,
                tenant_id=tenant_a,
                user_id="ada",
                role="member",
                organization_role="member",
            )
            await session.commit()

        async with organization_session(rls_harness.restricted, org_a) as session:
            roles = dict(
                (
                    await session.execute(
                        select(OrganizationMember.user_id, OrganizationMember.role)
                    )
                ).all()
            )

        assert roles == {"ada": "org_admin", "cy": "member"}
