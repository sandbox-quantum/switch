"""Creating an organization where organizations are kept in WorkOS: through
the members service, with the creator's own token, so the account exists in
every product sharing the environment, then linked here with its one
workspace, which is never added to or deleted.

Against Postgres, through the real routes, with WorkOS and the members
service answered in process.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Organization, OrganizationAuditEvent, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.admin_tokens import CREATING_AN_ORGANIZATION, SIGN_IN_ENDED
from switch_core.gateway.workspace_creation import ONE_WORKSPACE, ONLY_WORKSPACE
from tests.switch_core.gateway.test_member_changes_with_workos import (
    WORKOS_ORGANIZATION,
    _client_on,
    _signed_in_through_workos,
    _with,
    _WorkOS,
)
from tests.switch_core.gateway.test_organization_routes import (
    _KEYRING,
    _app,
    _client,
    _user,
    _workspaces_created,
)
from tests.switch_core.gateway.test_tenant_resolution import _session_app


class _Accounts(_WorkOS):
    """`_WorkOS`, with the members service creating accounts: each person
    gets one, named as they first asked, and is answered with it after."""

    def __init__(self) -> None:
        super().__init__({})
        self.created: list[tuple[str, str]] = []
        self.names: dict[str, str] = {}
        self.invitations: list[dict[str, str]] = []
        self.invitation_calls: list[tuple[str, str, str]] = []

    def api(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/organizations/{WORKOS_ORGANIZATION}":
            return httpx.Response(
                200,
                json={
                    "id": WORKOS_ORGANIZATION,
                    "name": next(iter(self.names.values())),
                    "metadata": {
                        "tenant_id": "ten_EXAMPLE",
                        "workspaces": json.dumps(
                            [{"id": "wks_EXAMPLE", "name": "Default"}]
                        ),
                    },
                },
            )
        return super().api(request)

    def members_service(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/auth/tenants/invitations"):
            return self._invitations(request)
        if request.url.path != "/v1/auth/tenants":
            return super().members_service(request)
        token = request.headers["Authorization"]
        name = json.loads(request.content)["name"]
        self.created.append((token, name))
        self.names.setdefault(token, name)
        return httpx.Response(201, json={"org_id": WORKOS_ORGANIZATION})

    def _invitations(self, request: httpx.Request) -> httpx.Response:
        """auth-gateway's invitation routes, recording each call with the
        organization its token was issued for."""
        token = request.headers["Authorization"].removeprefix("Bearer ")
        organization = jwt.decode(token, options={"verify_signature": False})["org_id"]
        path = request.url.path.removeprefix("/v1/auth/tenants/invitations")
        self.invitation_calls.append((request.method, path, organization))
        if request.method == "POST" and path == "":
            body = json.loads(request.content)
            invitation = {
                "id": f"invitation_{len(self.invitations) + 1}",
                "email": body["email"],
                "role": body["role"],
                "state": "pending",
                "organization_id": organization,
                "created_at": "2026-11-25T19:00:00.123456789Z",
                "expires_at": "2026-12-02T19:00:00Z",
            }
            self.invitations.append(invitation)
            return httpx.Response(201, json=invitation)
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "data": self.invitations,
                    "total": len(self.invitations),
                    "limit": 100,
                    "offset": 0,
                },
            )
        return httpx.Response(204 if request.method == "DELETE" else 200, json={})


async def _signed_in_newcomer(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, str]:
    ada = await _user(session_factory, "user")
    return ada, await _signed_in_through_workos(session_factory, ada)


class TestCreating:
    async def test_it_is_created_there_with_the_creators_token_and_linked_here(
        self, session_factory
    ) -> None:
        ada, isid = await _signed_in_newcomer(session_factory)
        workos = _Accounts()

        async with _client_on(
            _with(session_factory, workos), ada, None, isid
        ) as client:
            response = await client.post(
                "/organizations", json={"name": "Acme", "workspace_name": "Research"}
            )

        assert response.status_code == 201, response.text
        # Renewed on no organization: the creator has none yet.
        assert workos.refreshes == [
            {"refresh_token": "refresh-1", "organization_id": None}
        ]
        [(authorization, name)] = workos.created
        assert name == "Acme"
        assert authorization.startswith("Bearer ")
        body = response.json()
        async with session_factory() as session:
            organization = await session.get(Organization, body["organization"]["id"])
        assert organization is not None
        assert (organization.workos_organization_id, organization.customer_id) == (
            WORKOS_ORGANIZATION,
            "ten_EXAMPLE",
        )
        # Its one workspace, named as WorkOS names it, whatever was asked.
        assert body["workspace"]["name"] == "Default"
        async with tenant_session(session_factory, body["workspace"]["id"]) as session:
            tenant = await session.get(Tenant, body["workspace"]["id"])
        assert tenant is not None
        assert tenant.directory_workspace_id == "wks_EXAMPLE"
        assert await _workspaces_created(session_factory, ada) == 1

    async def test_one_already_linked_here_is_refused_naming_it(
        self, session_factory
    ) -> None:
        """WorkOS answers a second creation with the creator's first account,
        which Switch already follows: nothing new is made."""
        ada, isid = await _signed_in_newcomer(session_factory)
        workos = _Accounts()

        async with _client_on(
            _with(session_factory, workos), ada, None, isid
        ) as client:
            first = await client.post("/organizations", json={"name": "Acme"})
            again = await client.post("/organizations", json={"name": "Second"})

        assert first.status_code == 201, first.text
        assert again.status_code == 409
        assert "already created an organization, Acme" in again.json()["detail"]
        assert await _workspaces_created(session_factory, ada) == 1

    async def test_a_sign_in_that_has_ended_signs_in_again(
        self, session_factory
    ) -> None:
        ada, isid = await _signed_in_newcomer(session_factory)
        workos = _Accounts()
        workos.refresh_refuses = (400, "invalid_grant")
        workos.active = set()

        async with _client_on(
            _with(session_factory, workos), ada, None, isid
        ) as client:
            response = await client.post("/organizations", json={"name": "Acme"})

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["error"] == "directory_sign_in_required"
        assert detail["message"].startswith(
            SIGN_IN_ENDED.format(doing=CREATING_AN_ORGANIZATION)
        )
        assert detail["organization_id"] is None
        assert workos.created == []
        assert await _workspaces_created(session_factory, ada) == 0


class TestItsOneWorkspace:
    async def _created(self, session_factory) -> tuple[str, str, str]:
        ada, isid = await _signed_in_newcomer(session_factory)
        async with _client_on(
            _with(session_factory, _Accounts()), ada, None, isid
        ) as client:
            response = await client.post("/organizations", json={"name": "Acme"})
        assert response.status_code == 201, response.text
        return ada, isid, response.json()["workspace"]["id"]

    async def test_no_workspace_is_added(self, session_factory) -> None:
        ada, _, workspace_id = await self._created(session_factory)

        async with _client(
            _with(session_factory, _Accounts()), ada, workspace_id
        ) as client:
            response = await client.post(
                "/organizations/current/workspaces", json={"name": "Another"}
            )

        assert response.status_code == 409
        assert response.json()["detail"] == ONE_WORKSPACE

    async def test_it_is_not_deleted_but_is_renamed(self, session_factory) -> None:
        ada, _, workspace_id = await self._created(session_factory)

        async with _client(
            _with(session_factory, _Accounts()), ada, workspace_id
        ) as client:
            current = await client.get("/tenants/current")
            deleted = await client.request(
                "DELETE", f"/tenants/{workspace_id}", json={"name": "Default"}
            )
            renamed = await client.patch(
                f"/tenants/{workspace_id}", json={"name": "Research"}
            )

        # Not offered, and refused if asked.
        assert current.status_code == 200, current.text
        assert current.json()["can_delete"] is False
        assert deleted.status_code == 409
        assert deleted.json()["detail"] == ONLY_WORKSPACE
        assert renamed.status_code == 200, renamed.text
        async with tenant_session(session_factory, workspace_id) as session:
            tenant = await session.get(Tenant, workspace_id)
        assert tenant is not None
        assert (tenant.name, tenant.directory_workspace_id) == (
            "Research",
            "wks_EXAMPLE",
        )

    async def test_the_session_offers_no_workspace_to_add(
        self, session_factory
    ) -> None:
        ada, _, workspace_id = await self._created(session_factory)
        app = _session_app(session_factory, signup_mode="open")
        app.dependency_overrides[gw_deps.get_organization_directory] = _with(
            session_factory, _Accounts()
        ).dependency_overrides[gw_deps.get_organization_directory]
        app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
            keyring=_KEYRING,
            gateway_signup_mode="open",
            gateway_max_workspaces_per_user=3,
            gateway_license_version=None,
            organizations_created_in_directory=True,
            invite_email_enabled=False,
        )

        async with _client(app, ada, workspace_id) as client:
            response = await client.get("/auth/session")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["tenant"]["organization_role"] == "org_admin"
        assert body["can_add_workspace"] is False
        assert body["organizations_in_directory"] is True


class TestInvitingThroughTheDirectory:
    async def test_an_org_admin_invites_and_the_directory_sends_it(
        self, session_factory
    ) -> None:
        workos = _Accounts()
        ada, isid = await _signed_in_newcomer(session_factory)
        async with _client_on(
            _with(session_factory, workos), ada, None, isid
        ) as client:
            created = await client.post("/organizations", json={"name": "Acme"})
        workspace_id = created.json()["workspace"]["id"]

        async with _client_on(
            _with(session_factory, workos), ada, workspace_id, isid
        ) as client:
            member = await client.post(
                "/organizations/current/invitations",
                json={"email": "  Dana@Example.com ", "role": "member"},
            )
            admin = await client.post(
                "/organizations/current/invitations",
                json={"email": "eve@example.com", "role": "org_admin"},
            )
            listed = await client.get("/organizations/current/invitations")
            resent = await client.post(
                "/organizations/current/invitations/invitation_1/resend"
            )
            revoked = await client.delete(
                "/organizations/current/invitations/invitation_2"
            )

        assert member.status_code == 201, member.text
        assert member.json()["email"] == "dana@example.com"
        assert member.json()["role"] == "member"
        assert admin.json()["role"] == "org_admin"
        # A Member is invited as WorkOS's least role, an Org Admin as one.
        assert [i["role"] for i in workos.invitations] == ["viewer", "org_admin"]
        assert [i["email"] for i in listed.json()] == [
            "dana@example.com",
            "eve@example.com",
        ]
        assert (resent.status_code, revoked.status_code) == (204, 204)
        # Every call is made with the admin's token for the linked organization.
        assert {organization for _, _, organization in workos.invitation_calls} == {
            WORKOS_ORGANIZATION
        }
        assert [(method, path) for method, path, _ in workos.invitation_calls] == [
            ("POST", ""),
            ("POST", ""),
            ("GET", ""),
            ("POST", "/invitation_1/resend"),
            ("DELETE", "/invitation_2"),
        ]
        async with session_factory() as session:
            organization_id = created.json()["organization"]["id"]
            actions = list(
                await session.scalars(
                    select(OrganizationAuditEvent.action)
                    .where(
                        OrganizationAuditEvent.organization_id == organization_id,
                        OrganizationAuditEvent.target_type == "invitation",
                    )
                    .order_by(OrganizationAuditEvent.occurred_at)
                )
            )
        assert actions == [
            "organization.directory_invitation_sent",
            "organization.directory_invitation_sent",
            "organization.directory_invitation_resent",
            "organization.directory_invitation_revoked",
        ]

    async def test_an_organization_kept_here_invites_to_a_workspace_instead(
        self, session_factory
    ) -> None:
        ada = await _user(session_factory, "user")
        local = _app(session_factory)
        async with _client(local, ada, None) as client:
            created = await client.post("/organizations", json={"name": "Acme"})
        async with _client(local, ada, created.json()["workspace"]["id"]) as client:
            refused = await client.post(
                "/organizations/current/invitations",
                json={"email": "dana@example.com"},
            )

        assert refused.status_code == 409
        assert "invite people to one of its workspaces" in refused.json()["detail"]

    async def test_only_an_org_admin_invites(self, session_factory) -> None:
        workos = _Accounts()
        ada, isid = await _signed_in_newcomer(session_factory)
        async with _client_on(
            _with(session_factory, workos), ada, None, isid
        ) as client:
            created = await client.post("/organizations", json={"name": "Acme"})
        workspace_id = created.json()["workspace"]["id"]
        bob = await _user(session_factory, "user")
        async with tenant_session(session_factory, workspace_id) as session:
            await UserStore().add_membership(
                session,
                tenant_id=workspace_id,
                user_id=bob,
                role="member",
                organization_role="member",
            )
            await session.commit()

        async with _client(_with(session_factory, workos), bob, workspace_id) as client:
            refused = await client.post(
                "/organizations/current/invitations",
                json={"email": "dana@example.com"},
            )

        assert refused.status_code == 403
        assert workos.invitation_calls == []
