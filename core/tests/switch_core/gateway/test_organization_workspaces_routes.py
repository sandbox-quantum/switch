"""An organization's admins acting on any of its workspaces, against Postgres.

Renaming the organization; and, in a workspace other than the one their
request is bound to, renaming it, choosing its admins, changing a member's
role, removing them and inviting people, each done as the workspace's own
routes do it. Only the organization's admins, only its workspaces.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_OWNER_MARKER_META_KEY,
)
from switch_core.db.audit import AuditAction, OrganizationAuditAction
from switch_core.db.models import (
    AuditEvent,
    Invitation,
    Organization,
    OrganizationAuditEvent,
    OrganizationMember,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.session_scope import tenant_session
from tests.switch_core.gateway.test_organization_routes import (
    _app,
    _client,
    _name,
    _operator,
    _workspace,
)
from tests.switch_core.gateway.test_workspace_archive_routes import (
    WORKSPACES,
    _organization,
    _with_archive,
)

pytestmark = pytest.mark.asyncio


async def _role(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, user_id: str
) -> str | None:
    async with tenant_session(session_factory, tenant_id) as session:
        membership = await session.get(TenantMember, (tenant_id, user_id))
    return membership.role if membership is not None else None


async def _organization_events(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str, action: str
) -> list[dict]:
    async with tenant_session(session_factory, tenant_id) as session:
        return [
            event.details
            for event in await session.scalars(
                select(OrganizationAuditEvent).where(
                    OrganizationAuditEvent.action == action
                )
            )
        ]


class TestRenamingTheOrganization:
    async def test_an_org_admin_renames_it_and_it_is_audited(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            renamed = await client.patch(
                "/organizations/current", json={"name": "  Acme Labs  "}
            )
            again = await client.patch(
                "/organizations/current", json={"name": "Acme Labs"}
            )
            current = await client.get("/organizations/current")
            listed = await client.get("/organizations")

        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["name"] == "Acme Labs"
        assert again.status_code == 200
        assert current.json()["name"] == "Acme Labs"
        assert [row["name"] for row in listed.json()] == ["Acme Labs"]
        assert await _organization_events(
            session_factory, org.first, OrganizationAuditAction.ORGANIZATION_RENAMED
        ) == [
            {
                "name": "Acme Labs",
                "previous_name": "Acme",
                "workspace_id": org.first,
            }
        ]

    async def test_only_an_org_admin_renames_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        operator = await _operator(session_factory)

        answers = []
        for someone, workspace in (
            (org.carol, org.second),
            (org.bob, org.second),
            (operator, org.second),
        ):
            async with _client(app, someone, workspace) as client:
                answers.append(
                    (
                        await client.patch(
                            "/organizations/current", json={"name": "Taken over"}
                        )
                    ).status_code
                )

        assert answers == [403, 403, 403]
        async with session_factory() as session:
            names = set(await session.scalars(select(Organization.name)))
        assert "Taken over" not in names

    async def test_a_blank_or_multi_line_name_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            blank = await client.patch("/organizations/current", json={"name": "  "})
            broken = await client.patch(
                "/organizations/current", json={"name": "Two\nlines"}
            )

        assert (blank.status_code, broken.status_code) == (422, 422)


class TestAnotherWorkspace:
    async def test_an_org_admin_renames_another_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            renamed = await client.patch(
                f"{WORKSPACES}/{org.second}", json={"name": "Research"}
            )

        assert renamed.status_code == 200, renamed.text
        async with tenant_session(session_factory, org.second) as session:
            tenant = await session.get(Tenant, org.second)
        assert tenant is not None and tenant.name == "Research"
        assert await _organization_events(
            session_factory, org.second, OrganizationAuditAction.WORKSPACE_RENAMED
        ) == [
            {"name": "Research", "previous_name": "Second", "workspace_id": org.first}
        ]

    async def test_a_workspace_of_another_organization_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        other = await _workspace(
            session_factory, {_name("zed"): ("admin", "org_admin")}
        )

        async with _client(app, org.ada, org.first) as client:
            answers = [
                await client.patch(f"{WORKSPACES}/{other}", json={"name": "Mine"}),
                await client.put(f"{WORKSPACES}/{other}/admins", json={"user_ids": []}),
                await client.post(
                    f"{WORKSPACES}/{other}/invitations", json={"role": "member"}
                ),
            ]

        assert [answer.status_code for answer in answers] == [404, 404, 404]

    async def test_a_workspace_admin_who_is_no_org_admin_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.carol, org.second) as client:
            answers = [
                await client.patch(f"{WORKSPACES}/{org.first}", json={"name": "Mine"}),
                await client.patch(
                    f"{WORKSPACES}/{org.second}/members/{org.bob}",
                    json={"role": "admin"},
                ),
                await client.delete(f"{WORKSPACES}/{org.second}/members/{org.bob}"),
            ]

        assert [answer.status_code for answer in answers] == [403, 403, 403]
        assert await _role(session_factory, org.second, org.bob) == "member"


class TestChoosingAdmins:
    async def test_the_admins_chosen_become_its_only_admins(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            response = await client.put(
                f"{WORKSPACES}/{org.second}/admins", json={"user_ids": [org.bob]}
            )

        assert response.status_code == 200, response.text
        # Ada, an org admin, keeps the admin membership she made it with and
        # is not listed.
        assert response.json() == {
            "id": org.second,
            "name": "Second",
            "admins": [org.bob],
        }
        assert await _role(session_factory, org.second, org.bob) == "admin"
        assert await _role(session_factory, org.second, org.carol) == "member"
        async with tenant_session(session_factory, org.second) as session:
            changes = sorted(
                (event.target_id, event.details["to"])
                for event in await session.scalars(
                    select(AuditEvent).where(
                        AuditEvent.action == AuditAction.MEMBER_ROLE_CHANGED
                    )
                )
            )
        assert changes == sorted([(org.bob, "admin"), (org.carol, "member")])

    async def test_none_of_it_happens_when_the_last_admin_would_go(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        lone, member, ada = _name("lone"), _name("member"), _name("ada")
        tenant_id = await _workspace(
            session_factory,
            {lone: ("admin", "member"), member: ("member", "member")},
        )
        # Ada is its organization's admin with no membership of it.
        async with tenant_session(session_factory, tenant_id) as session:
            tenant = await session.get(Tenant, tenant_id)
            assert tenant is not None and tenant.organization_id is not None
            session.add(
                User(id=ada, name=ada, email=f"{ada}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                OrganizationMember(
                    organization_id=tenant.organization_id,
                    user_id=ada,
                    role="org_admin",
                )
            )
            await session.commit()

        async with _client(app, ada, tenant_id) as client:
            swapped = await client.put(
                f"{WORKSPACES}/{tenant_id}/admins", json={"user_ids": [member]}
            )
            emptied = await client.put(
                f"{WORKSPACES}/{tenant_id}/admins", json={"user_ids": []}
            )

        assert swapped.status_code == 200, swapped.text
        assert swapped.json()["admins"] == [member]
        assert emptied.status_code == 409
        assert "last admin" in emptied.json()["detail"]
        assert await _role(session_factory, tenant_id, member) == "admin"
        assert await _role(session_factory, tenant_id, lone) == "member"

    async def test_someone_not_choosable_is_refused_with_nothing_changed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            org_admin = await client.put(
                f"{WORKSPACES}/{org.second}/admins",
                json={"user_ids": [org.bob, org.ada]},
            )
            stranger = await client.put(
                f"{WORKSPACES}/{org.second}/admins",
                json={"user_ids": [org.bob, "nobody"]},
            )

        assert (org_admin.status_code, stranger.status_code) == (400, 400)
        assert await _role(session_factory, org.second, org.bob) == "member"

    async def test_the_service_account_is_not_made_an_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)
        async with session_factory() as session:
            bob = await session.get(User, org.bob)
            assert bob is not None
            bob.metadata_ = {BOOTSTRAP_OWNER_MARKER_META_KEY: True}
            await session.commit()

        async with _client(app, org.ada, org.first) as client:
            response = await client.put(
                f"{WORKSPACES}/{org.second}/admins",
                json={"user_ids": [org.bob, org.carol]},
            )

        assert response.status_code == 409
        assert await _role(session_factory, org.second, org.bob) == "member"


class TestItsMembers:
    async def test_an_org_admin_changes_a_members_role_there(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            changed = await client.patch(
                f"{WORKSPACES}/{org.second}/members/{org.bob}", json={"role": "admin"}
            )
            org_admin = await client.patch(
                f"{WORKSPACES}/{org.second}/members/{org.ada}", json={"role": "member"}
            )
            unknown = await client.patch(
                f"{WORKSPACES}/{org.second}/members/nobody", json={"role": "member"}
            )

        assert changed.status_code == 200, changed.text
        assert changed.json() == {
            "id": org.second,
            "name": "Second",
            "role": "admin",
            "archived": False,
        }
        assert org_admin.status_code == 409
        assert unknown.status_code == 404

    async def test_an_org_admin_removes_someone_from_another_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            preview = await client.get(
                f"{WORKSPACES}/{org.second}/members/{org.bob}/removal"
            )
            removed = await client.delete(
                f"{WORKSPACES}/{org.second}/members/{org.bob}"
            )
            members = await client.get("/organizations/current/members")

        assert preview.status_code == 200, preview.text
        # Ada made it, so she holds its admin membership and receives what
        # Bob owned.
        assert preview.json()["handed_over_to"]["user_id"] == org.ada
        assert removed.status_code == 200, removed.text
        assert removed.json()["ok"] is True
        assert await _role(session_factory, org.second, org.bob) is None
        [bob] = [row for row in members.json() if row["user_id"] == org.bob]
        assert bob["workspaces"] == []


class TestInviting:
    async def test_an_org_admin_makes_a_link_to_another_workspace(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        app = _app(session_factory)
        _with_archive(app)
        org = await _organization(session_factory, app)

        async with _client(app, org.ada, org.first) as client:
            made = await client.post(
                f"{WORKSPACES}/{org.second}/invitations", json={"role": "admin"}
            )
            await client.post(f"{WORKSPACES}/{org.second}/archive")
            refused = await client.post(
                f"{WORKSPACES}/{org.second}/invitations", json={"role": "member"}
            )

        assert made.status_code == 201, made.text
        assert made.json()["role"] == "admin" and made.json()["token"]
        async with tenant_session(session_factory, org.second) as session:
            [invitation] = list(await session.scalars(select(Invitation)))
        assert (invitation.tenant_id, invitation.created_by) == (org.second, org.ada)
        assert refused.status_code == 409
