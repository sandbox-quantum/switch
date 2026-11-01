"""Every route that changes who is in an organization asks the directory first.

Against Postgres, through the real routes, with a directory that records what
it is asked, or refuses. A refusal changes nothing in Switch, and a change the
rules refuse is never put to the directory.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Organization,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.invitation_store import InvitationStore
from switch_core.db.stores.join_domain_store import JoinDomainStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.organization_directory import (
    DirectoryOrganization,
    DirectoryRefusal,
)
from tests.switch_core.gateway.test_organization_routes import (
    _app,
    _client,
    _key_exists,
    _name,
    _personal_key,
    _second_workspace,
    _user,
    _workspace,
    _workspaces_created,
)

UNREACHABLE = "The organization directory could not be reached."


class _Directory:
    """Records what it is asked, in order; refuses everything when `refusing`."""

    def __init__(self, *, refusing: bool) -> None:
        self.refusing = refusing
        self.asked: list[tuple] = []

    def _answer(self, *call: object) -> None:
        self.asked.append(call)
        if self.refusing:
            raise DirectoryRefusal(UNREACHABLE)

    async def create_organization(
        self, creator: User, name: str
    ) -> DirectoryOrganization:
        self._answer("create", creator.id, name)
        return DirectoryOrganization(
            workos_organization_id="org_EXAMPLE", customer_id="customer-example"
        )

    async def join(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        self._answer("join", organization_id, user_id, role)

    async def set_role(
        self, session: AsyncSession, *, organization_id: str, user_id: str, role: str
    ) -> None:
        self._answer("set_role", organization_id, user_id, role)

    async def remove(
        self, session: AsyncSession, *, organization_id: str, user_id: str
    ) -> None:
        self._answer("remove", organization_id, user_id)


@pytest.fixture
def directory() -> _Directory:
    return _Directory(refusing=False)


@pytest.fixture
def refusing() -> _Directory:
    return _Directory(refusing=True)


def _with(
    session_factory: async_sessionmaker[AsyncSession], directory: _Directory
) -> FastAPI:
    app = _app(session_factory)
    app.dependency_overrides[gw_deps.get_organization_directory] = lambda: directory
    app.dependency_overrides[gw_deps.get_invitation_store] = lambda: InvitationStore()
    app.dependency_overrides[gw_deps.get_join_domain_store] = lambda: JoinDomainStore()
    return app


def _refused(response) -> None:
    assert response.status_code == 503, response.text
    assert response.json()["detail"] == f"{UNREACHABLE} Nothing was changed."


async def _organization_of(session_factory, tenant_id: str) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        tenant = await session.get(Tenant, tenant_id)
    assert tenant is not None and tenant.organization_id is not None
    return tenant.organization_id


async def _role(session_factory, tenant_id: str, user_id: str) -> str | None:
    organization_id = await _organization_of(session_factory, tenant_id)
    async with tenant_session(session_factory, tenant_id) as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
    return None if member is None else member.role


async def _outsider(session_factory) -> str:
    """Someone signed in who belongs to no workspace of the organization."""
    return await _user(session_factory, "user")


class TestCreating:
    async def test_the_directory_records_it_first_and_its_ids_are_kept(
        self, session_factory, directory: _Directory
    ) -> None:
        ada = await _user(session_factory, "user")

        async with _client(_with(session_factory, directory), ada, None) as client:
            response = await client.post("/organizations", json={"name": "Acme"})

        assert response.status_code == 201, response.text
        assert directory.asked == [("create", ada, "Acme")]
        async with session_factory() as session:
            organization = await session.get(
                Organization, response.json()["organization"]["id"]
            )
        assert organization is not None
        assert organization.workos_organization_id == "org_EXAMPLE"
        assert organization.customer_id == "customer-example"

    async def test_a_refusal_creates_nothing_and_counts_nothing(
        self, session_factory, refusing: _Directory
    ) -> None:
        ada = await _user(session_factory, "user")
        name = _name("Refused")

        async with _client(_with(session_factory, refusing), ada, None) as client:
            response = await client.post("/organizations", json={"name": name})

        _refused(response)
        async with session_factory() as session:
            assert (
                await session.scalar(
                    select(Organization).where(Organization.name == name)
                )
                is None
            )
        assert await _workspaces_created(session_factory, ada) == 0

    async def test_an_unusable_name_is_refused_before_the_directory_is_asked(
        self, session_factory, directory: _Directory
    ) -> None:
        ada = await _user(session_factory, "user")

        async with _client(_with(session_factory, directory), ada, None) as client:
            response = await client.post("/organizations", json={"name": "!!!"})

        assert response.status_code == 400
        assert directory.asked == []


async def _invitation(session_factory, tenant_id: str, inviter: str) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        _invitation, token = await InvitationStore().create(
            session,
            role="member",
            email=None,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            uses_remaining=1,
            created_by=inviter,
        )
        await session.commit()
    return token


class TestJoining:
    async def test_accepting_an_invitation_joins_the_organization_in_the_directory(
        self, session_factory, directory: _Directory
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        token = await _invitation(session_factory, tenant_id, ada)
        bob = await _outsider(session_factory)

        async with _client(_with(session_factory, directory), bob, None) as client:
            response = await client.post("/invitations/accept", json={"token": token})

        assert response.status_code == 200, response.text
        organization_id = await _organization_of(session_factory, tenant_id)
        assert directory.asked == [("join", organization_id, bob, "member")]
        assert await _role(session_factory, tenant_id, bob) == "member"

    async def test_a_refused_join_leaves_the_invitation_unspent(
        self, session_factory, refusing: _Directory, directory: _Directory
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        token = await _invitation(session_factory, tenant_id, ada)
        bob = await _outsider(session_factory)

        async with _client(_with(session_factory, refusing), bob, None) as client:
            refused = await client.post("/invitations/accept", json={"token": token})
        async with tenant_session(session_factory, tenant_id) as session:
            membership = await session.get(TenantMember, (tenant_id, bob))
        async with _client(_with(session_factory, directory), bob, None) as client:
            again = await client.post("/invitations/accept", json={"token": token})

        _refused(refused)
        assert membership is None
        assert await _role(session_factory, tenant_id, bob) == "member"
        # The single use was still there to spend.
        assert again.status_code == 200, again.text

    async def test_joining_by_domain_joins_the_organization_in_the_directory(
        self, session_factory, directory: _Directory, refusing: _Directory
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})
        async with tenant_session(session_factory, tenant_id) as session:
            await JoinDomainStore().add(
                session, domain="example.invalid", created_by=ada
            )
            await session.commit()
        bob = await _outsider(session_factory)

        async with _client(_with(session_factory, refusing), bob, None) as client:
            refused = await client.post(f"/joinable-tenants/{tenant_id}/join")
        async with _client(_with(session_factory, directory), bob, None) as client:
            joined = await client.post(f"/joinable-tenants/{tenant_id}/join")

        _refused(refused)
        assert joined.status_code == 200, joined.text
        organization_id = await _organization_of(session_factory, tenant_id)
        assert directory.asked == [("join", organization_id, bob, "member")]


class TestChangingRoles:
    async def test_the_directory_is_asked_before_the_role_changes(
        self, session_factory, directory: _Directory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_with(session_factory, directory), ada, tenant_id) as client:
            granted = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )
            unchanged = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert granted.status_code == 200, granted.text
        assert unchanged.status_code == 200, unchanged.text
        organization_id = await _organization_of(session_factory, tenant_id)
        # The second asked for the role bob already had: nothing to ask.
        assert directory.asked == [("set_role", organization_id, bob, "org_admin")]

    async def test_a_refused_demotion_takes_nothing_away(
        self, session_factory, refusing: _Directory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        first = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "org_admin")}
        )
        second = await _second_workspace(session_factory, first)
        key = await _personal_key(session_factory, second, bob)

        async with _client(_with(session_factory, refusing), ada, first) as client:
            response = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        _refused(response)
        assert await _role(session_factory, first, bob) == "org_admin"
        # What bob held where only org_admin let him in is still his.
        assert await _key_exists(session_factory, key)

    async def test_demoting_the_last_org_admin_is_refused_before_asking(
        self, session_factory, directory: _Directory
    ) -> None:
        ada = _name("ada")
        tenant_id = await _workspace(session_factory, {ada: ("owner", "org_admin")})

        async with _client(_with(session_factory, directory), ada, tenant_id) as client:
            response = await client.patch(
                f"/organizations/current/members/{ada}", json={"role": "member"}
            )

        assert response.status_code == 409
        assert directory.asked == []


class TestRemoving:
    async def _bob_in_no_workspace(self, session_factory) -> tuple[str, str, str]:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )
        async with tenant_session(session_factory, tenant_id) as session:
            await session.delete(await session.get(TenantMember, (tenant_id, bob)))
            await session.commit()
        return ada, bob, tenant_id

    async def test_the_directory_is_asked_before_they_are_removed(
        self, session_factory, directory: _Directory
    ) -> None:
        ada, bob, tenant_id = await self._bob_in_no_workspace(session_factory)

        async with _client(_with(session_factory, directory), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 200, response.text
        organization_id = await _organization_of(session_factory, tenant_id)
        assert directory.asked == [("remove", organization_id, bob)]
        assert await _role(session_factory, tenant_id, bob) is None

    async def test_a_refused_removal_keeps_them(
        self, session_factory, refusing: _Directory
    ) -> None:
        ada, bob, tenant_id = await self._bob_in_no_workspace(session_factory)

        async with _client(_with(session_factory, refusing), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")

        _refused(response)
        assert await _role(session_factory, tenant_id, bob) == "member"

    async def test_someone_still_in_a_workspace_is_refused_before_asking(
        self, session_factory, directory: _Directory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id = await _workspace(
            session_factory, {ada: ("owner", "org_admin"), bob: ("member", "member")}
        )

        async with _client(_with(session_factory, directory), ada, tenant_id) as client:
            response = await client.delete(f"/organizations/current/members/{bob}")

        assert response.status_code == 409
        assert directory.asked == []
