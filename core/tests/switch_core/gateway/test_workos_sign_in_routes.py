"""Changing a linked organization's members from Switch, with the admin's own
WorkOS token: refused until they sign in to the organization there, nothing
changed on the way, then made through the members service.

Against Postgres, through the real routes, with WorkOS and the members
service answered in process.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    OidcIdentity,
    Organization,
    OrganizationMember,
    User,
)
from switch_core.gateway import dependencies as gw_deps
from switch_core.members_service import MembersService
from switch_core.workos_directory import WorkOSDirectory
from switch_core.workos_sign_in import WorkOSOrganizationSignIn
from tests.switch_core.gateway.test_organization_routes import (
    _KEYRING,
    _app,
    _client,
    _name,
    _operator,
    _workspace,
)

ISSUER = "https://sign-in.example.test"
WORKOS_ORGANIZATION = "org_EXAMPLE"
ADMIN_TOKEN_OF = "token-of-"


class _WorkOS:
    """WorkOS, answering every sign-in code as `signs_in_as` in
    `organization` and listing `members` (WorkOS user -> (membership id,
    role)) to the API key, and the members service, recording each change
    with the token it came with, or answering it with `refuses_with`."""

    def __init__(self, members: dict[str, tuple[str, str]]) -> None:
        self.signs_in_as = ""
        self.organization = WORKOS_ORGANIZATION
        self.members = members
        self.refuses_with: int | None = None
        self.changes: list[tuple[str, str, str]] = []

    def sign_in(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "user": {"id": self.signs_in_as},
                "organization_id": self.organization,
                "access_token": jwt.encode(
                    {"exp": int(time.time()) + 300, "sub": self.signs_in_as},
                    "test-signing-key-long-enough-for-hs256",
                    algorithm="HS256",
                ),
            },
        )

    def api(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/user_management/organization_memberships"
        subject = request.url.params["user_id"]
        listed = self.members.get(subject)
        return httpx.Response(
            200,
            json={
                "data": []
                if listed is None
                else [
                    {
                        "id": listed[0],
                        "user_id": subject,
                        "organization_id": request.url.params["organization_id"],
                        "role": {"slug": listed[1]},
                    }
                ],
                "list_metadata": {"after": None},
            },
        )

    def members_service(self, request: httpx.Request) -> httpx.Response:
        if self.refuses_with is not None:
            return httpx.Response(self.refuses_with, json={"error": "refused"})
        self.changes.append(
            (
                request.method,
                request.url.path.rsplit("/", 1)[1],
                request.headers["Authorization"],
            )
        )
        return httpx.Response(200, json={})


def _with(
    session_factory: async_sessionmaker[AsyncSession], workos: _WorkOS
) -> FastAPI:
    app = _app(session_factory)
    directory = WorkOSDirectory(
        httpx.AsyncClient(transport=httpx.MockTransport(workos.api)),
        "workos-api-key-placeholder",
        "https://api.workos.example.test",
        ISSUER,
        MembersService(
            httpx.AsyncClient(transport=httpx.MockTransport(workos.members_service)),
            "https://members.example.test",
        ),
    )
    app.dependency_overrides[gw_deps.get_organization_directory] = lambda: directory
    app.state.workos_sign_in = WorkOSOrganizationSignIn(
        httpx.AsyncClient(transport=httpx.MockTransport(workos.sign_in)),
        "workos-api-key-placeholder",
        "https://api.workos.example.test",
        "client_EXAMPLE",
        "https://switch.example.test/gateway/auth/workos/callback",
    )
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_signup_mode="open",
        gateway_max_workspaces_per_user=3,
        frontend_base_url=None,
    )
    return app


async def _linked(
    session_factory: async_sessionmaker[AsyncSession], members: dict[str, tuple]
) -> tuple[str, str]:
    """A workspace in an organization linked to WorkOS, each member with a
    WorkOS identity `user_<name>`. Returns (tenant, organization)."""
    tenant_id = await _workspace(session_factory, members)
    async with session_factory() as session:
        organization_id = await session.scalar(
            select(OrganizationMember.organization_id).where(
                OrganizationMember.user_id == next(iter(members))
            )
        )
        organization = await session.get(Organization, organization_id)
        assert organization is not None
        organization.workos_organization_id = WORKOS_ORGANIZATION
        for name in members:
            session.add(OidcIdentity(user_id=name, iss=ISSUER, sub=f"user_{name}"))
        await session.commit()
    return tenant_id, organization.id


async def _role(
    session_factory: async_sessionmaker[AsyncSession],
    organization_id: str,
    user_id: str,
) -> str | None:
    async with session_factory() as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
        return None if member is None else member.role


async def _sign_in_to_workos(client: httpx.AsyncClient) -> httpx.Response:
    started = await client.get(
        "/auth/workos/organization", params={"return_to": "/organization"}
    )
    assert started.status_code == 302, started.text
    location = urlsplit(started.headers["location"])
    query = parse_qs(location.query)
    assert query["organization_id"] == [WORKOS_ORGANIZATION]
    return await client.get(
        "/auth/workos/callback",
        params={"code": "the-code", "state": query["state"][0]},
    )


class TestChangingMembers:
    async def test_a_change_waits_for_the_admin_to_sign_in_to_workos(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})
        workos.signs_in_as = f"user_{ada}"

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            refused = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )
            signed_in = await _sign_in_to_workos(client)
            made = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert refused.status_code == 403
        assert refused.json()["detail"]["error"] == "directory_sign_in_required"
        assert signed_in.status_code == 303
        assert signed_in.headers["location"] == "/organization"
        assert made.status_code == 200, made.text
        [(method, membership, authorization)] = workos.changes
        assert (method, membership) == ("PATCH", "om_bob")
        assert authorization.startswith("Bearer ")
        assert await _role(session_factory, organization_id, bob) == "org_admin"

    async def test_a_refused_demotion_takes_nothing_away(self, session_factory) -> None:
        """Asked before anything changes: no workspace access is ended for a
        change that then waits on a sign-in."""
        ada, cy = _name("ada"), _name("cy")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), cy: ("admin", "org_admin")}
        )
        workos = _WorkOS({f"user_{cy}": ("om_cy", "org_admin")})

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            refused = await client.patch(
                f"/organizations/current/members/{cy}", json={"role": "member"}
            )

        assert refused.status_code == 403
        assert "Nothing was changed." in refused.json()["detail"]["message"]
        assert await _role(session_factory, organization_id, cy) == "org_admin"
        assert workos.changes == []

    async def test_a_removal_goes_through_the_members_service(
        self, session_factory
    ) -> None:
        ada, dee = _name("ada"), _name("dee")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin")}
        )
        async with session_factory() as session:
            session.add(
                User(id=dee, name=dee, email=f"{dee}@example.invalid", role="user")
            )
            await session.flush()
            session.add(
                OrganizationMember(
                    organization_id=organization_id, user_id=dee, role="member"
                )
            )
            session.add(OidcIdentity(user_id=dee, iss=ISSUER, sub=f"user_{dee}"))
            await session.commit()
        workos = _WorkOS({f"user_{dee}": ("om_dee", "viewer")})
        workos.signs_in_as = f"user_{ada}"

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            await _sign_in_to_workos(client)
            removed = await client.delete(f"/organizations/current/members/{dee}")

        assert removed.status_code == 200, removed.text
        assert [(m, om) for m, om, _ in workos.changes] == [("DELETE", "om_dee")]
        assert await _role(session_factory, organization_id, dee) is None

    async def test_a_change_workos_does_not_need_waits_for_no_sign_in(
        self, session_factory
    ) -> None:
        """Someone WorkOS lists in a role of another product, or not at all,
        or who has no WorkOS identity, is made a Member in Switch alone."""
        ada, cy, eli, fay = _name("ada"), _name("cy"), _name("eli"), _name("fay")
        tenant_id, organization_id = await _linked(
            session_factory,
            {
                ada: ("admin", "org_admin"),
                cy: ("admin", "org_admin"),
                eli: ("admin", "org_admin"),
                fay: ("admin", "org_admin"),
            },
        )
        async with session_factory() as session:
            identity = await session.scalar(
                select(OidcIdentity).where(OidcIdentity.user_id == fay)
            )
            await session.delete(identity)
            await session.commit()
        workos = _WorkOS({f"user_{cy}": ("om_cy", "editor")})

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            made = [
                await client.patch(
                    f"/organizations/current/members/{who}", json={"role": "member"}
                )
                for who in (cy, eli, fay)
            ]

        assert [response.status_code for response in made] == [200, 200, 200]
        assert workos.changes == []
        for who in (cy, eli, fay):
            assert await _role(session_factory, organization_id, who) == "member"

    async def test_demoting_the_last_org_admin_is_refused_before_any_sign_in(
        self, session_factory
    ) -> None:
        ada = _name("ada")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin")}
        )
        workos = _WorkOS({f"user_{ada}": ("om_ada", "org_admin")})

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            refused = await client.patch(
                f"/organizations/current/members/{ada}", json={"role": "member"}
            )

        assert refused.status_code == 409
        assert refused.json()["detail"] == "Cannot demote the last organization admin"
        assert await _role(session_factory, organization_id, ada) == "org_admin"

    async def test_a_removal_refused_for_its_workspaces_asks_for_no_sign_in(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, _ = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            refused = await client.delete(f"/organizations/current/members/{bob}")

        assert refused.status_code == 409
        assert "workspaces first" in refused.json()["detail"]

    async def test_a_token_not_accepted_after_access_was_ended_says_so(
        self, session_factory
    ) -> None:
        ada, cy = _name("ada"), _name("cy")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), cy: ("admin", "org_admin")}
        )
        workos = _WorkOS({f"user_{cy}": ("om_cy", "org_admin")})
        workos.signs_in_as = f"user_{ada}"

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            await _sign_in_to_workos(client)
            workos.refuses_with = 401
            refused = await client.patch(
                f"/organizations/current/members/{cy}", json={"role": "member"}
            )

        # The token has not run out, so signing in again would not help.
        assert refused.status_code == 503
        detail = refused.json()["detail"]
        assert "doesn't accept member changes from Switch" in detail
        assert "already been taken away" in detail
        assert await _role(session_factory, organization_id, cy) == "org_admin"


class TestOperatorRestoring:
    async def test_an_operator_is_told_who_can_make_the_change(
        self, session_factory
    ) -> None:
        bob = _name("bob")
        tenant_id, organization_id = await _linked(
            session_factory, {bob: ("admin", "member")}
        )
        operator_id = await _operator(session_factory)
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})

        async with _client(
            _with(session_factory, workos), operator_id, tenant_id
        ) as client:
            refused = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert refused.status_code == 409
        assert "account settings" in refused.json()["detail"]
        assert await _role(session_factory, organization_id, bob) == "member"

    async def test_an_operator_restores_whom_workos_already_has_as_org_admin(
        self, session_factory
    ) -> None:
        bob = _name("bob")
        tenant_id, organization_id = await _linked(
            session_factory, {bob: ("admin", "member")}
        )
        operator_id = await _operator(session_factory)
        workos = _WorkOS({f"user_{bob}": ("om_bob", "org_admin")})

        async with _client(
            _with(session_factory, workos), operator_id, tenant_id
        ) as client:
            restored = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert restored.status_code == 200, restored.text
        assert workos.changes == []
        assert await _role(session_factory, organization_id, bob) == "org_admin"


class TestSigningIn:
    async def test_signing_in_as_someone_else_keeps_no_token(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, _ = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})
        workos.signs_in_as = f"user_{bob}"

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            signed_in = await _sign_in_to_workos(client)
            refused = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )

        assert signed_in.status_code == 403
        assert refused.status_code == 403
        assert workos.changes == []

    async def test_a_token_for_another_organization_is_not_kept(
        self, session_factory
    ) -> None:
        ada = _name("ada")
        tenant_id, _ = await _linked(session_factory, {ada: ("admin", "org_admin")})
        workos = _WorkOS({})
        workos.signs_in_as = f"user_{ada}"
        workos.organization = "org_SOMEWHERE_ELSE"

        async with _client(_with(session_factory, workos), ada, tenant_id) as client:
            signed_in = await _sign_in_to_workos(client)

        assert signed_in.status_code == 403

    async def test_a_callback_not_started_here_is_refused(
        self, session_factory
    ) -> None:
        ada = _name("ada")
        tenant_id, _ = await _linked(session_factory, {ada: ("admin", "org_admin")})

        async with _client(
            _with(session_factory, _WorkOS({})), ada, tenant_id
        ) as client:
            response = await client.get(
                "/auth/workos/callback", params={"code": "c", "state": "forged"}
            )

        assert response.status_code == 400

    async def test_only_an_org_admin_of_a_linked_organization_starts_one(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, _ = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        eve = _name("eve")
        unlinked = await _workspace(session_factory, {eve: ("admin", "org_admin")})
        app = _with(session_factory, _WorkOS({}))

        async with _client(app, bob, tenant_id) as client:
            as_member = await client.get(
                "/auth/workos/organization", params={"return_to": "/organization"}
            )
        async with _client(app, eve, unlinked) as client:
            not_linked = await client.get(
                "/auth/workos/organization", params={"return_to": "/organization"}
            )
        async with _client(app, ada, tenant_id) as client:
            elsewhere = [
                await client.get(
                    "/auth/workos/organization", params={"return_to": return_to}
                )
                for return_to in (
                    "https://elsewhere.example.test/",
                    "//elsewhere.example.test/organization",
                )
            ]

        assert as_member.status_code == 403
        assert not_linked.status_code == 409
        assert [response.status_code for response in elsewhere] == [400, 400]

    async def test_nothing_to_sign_in_to_where_changes_are_not_sent(
        self, session_factory
    ) -> None:
        ada = _name("ada")
        tenant_id, _ = await _linked(session_factory, {ada: ("admin", "org_admin")})
        app = _with(session_factory, _WorkOS({}))
        app.state.workos_sign_in = None

        async with _client(app, ada, tenant_id) as client:
            response = await client.get(
                "/auth/workos/organization", params={"return_to": "/organization"}
            )

        assert response.status_code == 404
