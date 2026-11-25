"""Changing a linked organization's members from Switch, with the admin's own
WorkOS token: renewed for the organization from the refresh token their
sign-in keeps, only when WorkOS has to change, and made through the members
service. Nobody signs in a second time.

Against Postgres, through the real routes, with WorkOS and the members
service answered in process.
"""

from __future__ import annotations

import json
import secrets
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import jwt
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    IdentitySession,
    OidcIdentity,
    Organization,
    OrganizationMember,
    User,
)
from switch_core.db.stores.identity_session_store import IdentitySessionStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.admin_tokens import (
    CHANGING_MEMBERS,
    NOT_THROUGH_WORKOS,
    SIGN_IN_AGAIN,
    SIGN_IN_ENDED,
)
from switch_core.gateway.auth import create_jwt
from switch_core.gateway.identity_sessions import IdentitySessions
from switch_core.members_service import MembersService
from switch_core.workos_authkit import AuthKit
from switch_core.workos_directory import WorkOSDirectory
from tests.switch_core.gateway.test_organization_routes import (
    _KEYRING,
    _app,
    _client,
    _name,
    _operator,
    _workspace,
)

ISSUER = "https://sign-in.example.test"
API = "https://api.workos.example.test"
WORKOS_ORGANIZATION = "org_EXAMPLE"
SIGNING_KEY = "x" * 40


def _access_token(organization_id: str | None, expires_in: int = 300) -> str:
    return jwt.encode(
        {
            "sub": "user_admin",
            "sid": "session_ADMIN",
            "org_id": organization_id,
            "exp": int(time.time()) + expires_in,
        },
        SIGNING_KEY,
        algorithm="HS256",
    )


class _WorkOS:
    """WorkOS, listing `members` (WorkOS user -> (membership id, role)) to
    the API key, renewing refresh tokens (`refresh_refuses` answers a renewal
    with (status, code) instead), listing `active` sessions, and the members
    service, recording each change with the token it came with, or answering
    it with `refuses_with`."""

    def __init__(self, members: dict[str, tuple[str, str]]) -> None:
        self.members = members
        self.refreshes: list[dict[str, str]] = []
        self.refresh_refuses: tuple[int, str] | None = None
        self.spent: set[str] = set()
        self.active: set[str] = {"session_ADMIN"}
        self.refuses_with: int | None = None
        self.changes: list[tuple[str, str, str]] = []

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

    def authkit(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/sessions"):
            return httpx.Response(
                200,
                json={
                    "data": [{"id": session_id} for session_id in self.active],
                    "list_metadata": {"after": None},
                },
            )
        assert request.url.path == "/user_management/authenticate"
        grant = json.loads(request.content)
        assert grant["grant_type"] == "refresh_token"
        self.refreshes.append(
            {
                "refresh_token": grant["refresh_token"],
                "organization_id": grant.get("organization_id"),
            }
        )
        if grant["refresh_token"] in self.spent:
            return httpx.Response(400, json={"error": "invalid_grant"})
        if self.refresh_refuses is not None:
            status, code = self.refresh_refuses
            return httpx.Response(
                status, json={"error": code, "error_description": "Refused."}
            )
        return httpx.Response(
            200,
            json={
                "user": {"id": "user_admin", "email": "admin@example.test"},
                "organization_id": grant.get("organization_id"),
                "access_token": _access_token(grant.get("organization_id")),
                "refresh_token": f"refresh-{len(self.refreshes) + 1}",
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


def _authkit(workos: _WorkOS) -> AuthKit:
    return AuthKit(
        httpx.AsyncClient(transport=httpx.MockTransport(workos.authkit)),
        "workos-api-key-placeholder",
        API,
        "client_EXAMPLE",
    )


def _with(
    session_factory: async_sessionmaker[AsyncSession], workos: _WorkOS
) -> FastAPI:
    app = _app(session_factory)
    directory = WorkOSDirectory(
        httpx.AsyncClient(transport=httpx.MockTransport(workos.api)),
        "workos-api-key-placeholder",
        API,
        ISSUER,
        MembersService(
            httpx.AsyncClient(transport=httpx.MockTransport(workos.members_service)),
            "https://members.example.test",
        ),
    )
    app.dependency_overrides[gw_deps.get_organization_directory] = lambda: directory
    app.state.identity_sessions = IdentitySessions(
        session_factory, _authkit(workos), _KEYRING
    )
    # A server with organizations created in WorkOS, as this directory makes them.
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace(
        keyring=_KEYRING,
        gateway_cookie_secure=False,
        gateway_tenant_choice_enabled=False,
        gateway_signup_mode="open",
        gateway_max_workspaces_per_user=3,
        gateway_license_version=None,
        organizations_created_in_directory=True,
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


async def _signed_in_through_workos(
    session_factory: async_sessionmaker[AsyncSession],
    user_id: str,
    refresh_token: str = "refresh-1",
) -> str:
    """The identity session a sign-in through AuthKit records, as its id."""
    async with session_factory() as session:
        row_id = await IdentitySessionStore().record(
            session,
            user_id=user_id,
            provider="workos",
            provider_user_id=f"user_{user_id}",
            session_id="session_ADMIN",
            encrypted_refresh_token=_KEYRING.encrypt(refresh_token),
            now=datetime.now(UTC),
        )
        await session.commit()
    return row_id


def _client_on(
    app: FastAPI, user_id: str, tenant_id: str | None, identity_session: str
) -> httpx.AsyncClient:
    token = create_jwt(
        user_id,
        f"{user_id}@example.invalid",
        "user",
        _KEYRING,
        tenant_id,
        session_version=0,
        auth_time=datetime.now(UTC),
        session_id=secrets.token_urlsafe(16),
        identity_session=identity_session,
    )
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
        cookies={"switch_auth": token},
    )


async def _kept(
    session_factory: async_sessionmaker[AsyncSession], row_id: str
) -> tuple[str | None, datetime | None]:
    """The refresh token an identity session keeps, decrypted (None once it
    has ended and kept none), and when it ended."""
    async with session_factory() as session:
        row = await session.get(IdentitySession, row_id)
    assert row is not None
    kept = row.encrypted_refresh_token
    return (_KEYRING.decrypt(kept) if kept else None), row.ended_at


async def _role(
    session_factory: async_sessionmaker[AsyncSession],
    organization_id: str,
    user_id: str,
) -> str | None:
    async with session_factory() as session:
        member = await session.get(OrganizationMember, (organization_id, user_id))
        return None if member is None else member.role


class TestChangingMembers:
    async def test_a_change_workos_needs_is_made_with_the_admins_own_sign_in(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            made = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "org_admin"}
            )
            workos.members[f"user_{bob}"] = ("om_bob", "org_admin")
            again = await client.patch(
                f"/organizations/current/members/{bob}", json={"role": "member"}
            )

        assert made.status_code == 200, made.text
        assert again.status_code == 200, again.text
        # Renewed for the linked organization, each time from the token the
        # renewal before rotated it to.
        assert workos.refreshes == [
            {"refresh_token": "refresh-1", "organization_id": WORKOS_ORGANIZATION},
            {"refresh_token": "refresh-2", "organization_id": WORKOS_ORGANIZATION},
        ]
        assert await _kept(session_factory, isid) == ("refresh-3", None)
        [(method, membership, authorization), _] = workos.changes
        assert (method, membership) == ("PATCH", "om_bob")
        claims = jwt.decode(
            authorization.removeprefix("Bearer "), options={"verify_signature": False}
        )
        assert claims["org_id"] == WORKOS_ORGANIZATION
        assert await _role(session_factory, organization_id, bob) == "member"

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
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{dee}": ("om_dee", "viewer")})

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            removed = await client.delete(f"/organizations/current/members/{dee}")

        assert removed.status_code == 200, removed.text
        assert [(m, om) for m, om, _ in workos.changes] == [("DELETE", "om_dee")]
        assert await _role(session_factory, organization_id, dee) is None

    async def test_a_change_workos_does_not_need_renews_nothing(
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
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{cy}": ("om_cy", "editor")})

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            made = [
                await client.patch(
                    f"/organizations/current/members/{who}", json={"role": "member"}
                )
                for who in (cy, eli, fay)
            ]

        assert [response.status_code for response in made] == [200, 200, 200]
        assert workos.refreshes == []
        assert workos.changes == []
        for who in (cy, eli, fay):
            assert await _role(session_factory, organization_id, who) == "member"

    async def test_demoting_the_last_org_admin_is_refused_before_workos_is_asked(
        self, session_factory
    ) -> None:
        ada = _name("ada")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin")}
        )
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{ada}": ("om_ada", "org_admin")})

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            refused = await client.patch(
                f"/organizations/current/members/{ada}", json={"role": "member"}
            )

        assert refused.status_code == 409
        assert refused.json()["detail"] == "Cannot demote the last organization admin"
        assert workos.refreshes == []
        assert await _role(session_factory, organization_id, ada) == "org_admin"

    async def test_a_removal_refused_for_its_workspaces_renews_nothing(
        self, session_factory
    ) -> None:
        ada, bob = _name("ada"), _name("bob")
        tenant_id, _ = await _linked(
            session_factory, {ada: ("admin", "org_admin"), bob: ("member", "member")}
        )
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{bob}": ("om_bob", "viewer")})

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            refused = await client.delete(f"/organizations/current/members/{bob}")

        assert refused.status_code == 409
        assert "workspaces first" in refused.json()["detail"]
        assert workos.refreshes == []

    async def test_a_token_not_accepted_after_access_was_ended_says_so(
        self, session_factory
    ) -> None:
        ada, cy = _name("ada"), _name("cy")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), cy: ("admin", "org_admin")}
        )
        isid = await _signed_in_through_workos(session_factory, ada)
        workos = _WorkOS({f"user_{cy}": ("om_cy", "org_admin")})
        workos.refuses_with = 401

        async with _client_on(
            _with(session_factory, workos), ada, tenant_id, isid
        ) as client:
            refused = await client.patch(
                f"/organizations/current/members/{cy}", json={"role": "member"}
            )

        # The token has not run out, so signing in again would not help.
        assert refused.status_code == 503
        detail = refused.json()["detail"]
        assert "doesn't accept member changes from Switch" in detail
        assert "already been taken away" in detail
        assert await _role(session_factory, organization_id, cy) == "org_admin"


class TestWhenTheTokenCannotBeRenewed:
    """Asked before anything changes, so a change that can't get the admin's
    token takes nothing away on the way."""

    async def _demote(
        self, session_factory, workos: _WorkOS, *, signed_in: bool = True
    ) -> tuple[httpx.Response, str | None]:
        ada, cy = _name("ada"), _name("cy")
        tenant_id, organization_id = await _linked(
            session_factory, {ada: ("admin", "org_admin"), cy: ("admin", "org_admin")}
        )
        workos.members[f"user_{cy}"] = ("om_cy", "org_admin")
        app = _with(session_factory, workos)
        isid = await _signed_in_through_workos(session_factory, ada)
        client = (
            _client_on(app, ada, tenant_id, isid)
            if signed_in
            else _client(app, ada, tenant_id)
        )
        async with client:
            response = await client.patch(
                f"/organizations/current/members/{cy}", json={"role": "member"}
            )
        assert await _role(session_factory, organization_id, cy) == "org_admin"
        assert workos.changes == []
        return response, (isid if signed_in else None)

    async def test_a_session_ended_at_workos_ends_here_and_signs_in_again(
        self, session_factory
    ) -> None:
        workos = _WorkOS({})
        workos.refresh_refuses = (400, "invalid_grant")
        workos.active = set()

        response, isid = await self._demote(session_factory, workos)

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["error"] == "directory_sign_in_required"
        assert detail["message"].startswith(
            SIGN_IN_ENDED.format(doing=CHANGING_MEMBERS)
        )
        # So the sign-in again is to the organization, its own way.
        assert detail["organization_id"] == WORKOS_ORGANIZATION
        assert "Nothing was changed." in detail["message"]
        assert isid is not None
        kept, ended_at = await _kept(session_factory, isid)
        assert kept is None
        assert ended_at is not None

    async def test_a_spent_token_of_a_live_session_signs_in_again(
        self, session_factory
    ) -> None:
        """The session is still alive, so it is not ended: a sign-in again
        gets a token to renew from."""
        workos = _WorkOS({})
        workos.refresh_refuses = (400, "invalid_grant")

        response, isid = await self._demote(session_factory, workos)

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["error"] == "directory_sign_in_required"
        assert detail["message"].startswith(
            SIGN_IN_AGAIN.format(doing=CHANGING_MEMBERS)
        )
        assert isid is not None
        assert await _kept(session_factory, isid) == ("refresh-1", None)

    async def test_an_organization_wanting_its_own_sign_in_signs_in_again(
        self, session_factory
    ) -> None:
        workos = _WorkOS({})
        workos.refresh_refuses = (400, "sso_required")

        response, isid = await self._demote(session_factory, workos)

        assert response.status_code == 403
        assert response.json()["detail"]["message"].startswith(
            SIGN_IN_AGAIN.format(doing=CHANGING_MEMBERS)
        )
        assert isid is not None
        assert await _kept(session_factory, isid) == ("refresh-1", None)

    async def test_workos_refusing_the_organization_is_a_refusal(
        self, session_factory
    ) -> None:
        workos = _WorkOS({})
        workos.refresh_refuses = (403, "organization_membership_not_found")

        response, _ = await self._demote(session_factory, workos)

        assert response.status_code == 409
        assert (
            "won't let you change the organization's members"
            in response.json()["detail"]
        )

    async def test_workos_out_of_reach_changes_nothing(self, session_factory) -> None:
        workos = _WorkOS({})
        workos.refresh_refuses = (503, "unavailable")

        response, isid = await self._demote(session_factory, workos)

        assert response.status_code == 503
        assert "could not be reached" in response.json()["detail"]
        assert isid is not None
        assert await _kept(session_factory, isid) == ("refresh-1", None)

    async def test_a_sign_in_not_through_workos_is_sent_through_it(
        self, session_factory
    ) -> None:
        workos = _WorkOS({})

        response, _ = await self._demote(session_factory, workos, signed_in=False)

        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["error"] == "directory_sign_in_required"
        assert detail["message"].startswith(
            NOT_THROUGH_WORKOS.format(doing=CHANGING_MEMBERS)
        )
        assert workos.refreshes == []


class TestRenewingAtOnce:
    async def test_a_renewal_beaten_to_the_token_renews_from_the_one_kept(
        self, session_factory, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Another renewal spent the token this one read, and kept the one
        WorkOS rotated it to: this one renews from that, rather than taking
        WorkOS's refusal of the spent token for an ended session."""
        ada = _name("ada")
        await _linked(session_factory, {ada: ("admin", "org_admin")})
        isid = await _signed_in_through_workos(session_factory, ada, "refresh-old")
        workos = _WorkOS({})
        workos.spent = {"refresh-old"}
        read = IdentitySessionStore.refresh_token
        reads = 0

        async def read_then_rotate(
            store: IdentitySessionStore, db: AsyncSession, row_id: str
        ) -> str | None:
            nonlocal reads
            reads += 1
            kept = await read(store, db, row_id)
            if reads == 1:
                # The other renewal finishes between this one's read and its
                # call to WorkOS.
                assert kept is not None
                async with session_factory() as other, other.begin():
                    await IdentitySessionStore().replace_refresh_token(
                        other,
                        row_id,
                        spent=kept,
                        renewed=_KEYRING.encrypt("refresh-new"),
                    )
            return kept

        monkeypatch.setattr(IdentitySessionStore, "refresh_token", read_then_rotate)
        sessions = IdentitySessions(session_factory, _authkit(workos), _KEYRING)
        token = await sessions.organization_token(ada, isid, WORKOS_ORGANIZATION)

        claims = jwt.decode(token, options={"verify_signature": False})
        assert claims["org_id"] == WORKOS_ORGANIZATION
        assert [grant["refresh_token"] for grant in workos.refreshes] == [
            "refresh-old",
            "refresh-new",
        ]
        assert await _kept(session_factory, isid) == ("refresh-3", None)


class TestKeyRotationMeanwhile:
    async def test_a_token_rewritten_under_another_key_is_still_replaced(
        self, session_factory, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Boot re-encrypts stored tokens under the current key: the same
        token, new ciphertext. A renewal that read it before keeps the token
        WorkOS rotated it to all the same, rather than leaving the spent one
        to fail the next renewal."""
        ada = _name("ada")
        await _linked(session_factory, {ada: ("admin", "org_admin")})
        isid = await _signed_in_through_workos(session_factory, ada, "refresh-1")
        workos = _WorkOS({})
        read = IdentitySessionStore.refresh_token
        reads = 0

        async def read_then_reencrypt(
            store: IdentitySessionStore, db: AsyncSession, row_id: str
        ) -> str | None:
            nonlocal reads
            reads += 1
            kept = await read(store, db, row_id)
            if reads == 1:
                assert kept is not None
                async with session_factory() as other, other.begin():
                    await IdentitySessionStore().replace_refresh_token(
                        other,
                        row_id,
                        spent=kept,
                        renewed=_KEYRING.encrypt(_KEYRING.decrypt(kept)),
                    )
            return kept

        monkeypatch.setattr(IdentitySessionStore, "refresh_token", read_then_reencrypt)
        sessions = IdentitySessions(session_factory, _authkit(workos), _KEYRING)
        await sessions.organization_token(ada, isid, WORKOS_ORGANIZATION)

        monkeypatch.undo()
        assert await _kept(session_factory, isid) == ("refresh-2", None)


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
        assert workos.refreshes == []
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
