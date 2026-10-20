from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import RedirectResponse
from starlette.testclient import TestClient

import switch_core.gateway.oidc_routes as oidc_routes
from switch_core.config import SwitchConfig
from switch_core.db.models import (
    TENANT_ZERO_ID,
    OidcIdentity,
    Tenant,
    TenantMember,
    User,
)
from switch_core.db.stores.user_store import OidcIdentityRaceError, UserStore
from switch_core.gateway.auth import decode_jwt, hash_password
from switch_core.gateway.auth_routes import auth_config
from switch_core.gateway.dependencies import get_config


def _tenant_claim(set_cookie: str) -> str | None:
    token = set_cookie.split("switch_auth=", 1)[1].split(";", 1)[0]
    claim: str | None = decode_jwt(token, _config().keyring).get("tenant_id")
    return claim


def _config(**overrides: object) -> SwitchConfig:
    base: dict[str, object] = dict(
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        id_server_name="m",
        agent_registration_token="t",
        secret_keys="test:" + "x" * 40,
        gateway_admin_email="a@b.c",
        gateway_admin_password="pw",
        gateway_oidc_issuer_url="https://idp.example",
        gateway_oidc_client_id="cid",
        gateway_oidc_client_secret="sec",
        gateway_oidc_scopes="openid email profile",
    )
    base.update(overrides)
    return SwitchConfig(**base)  # type: ignore[arg-type]


class _FakeClient:
    """Stands in for the authlib OIDC client at the callback."""

    def __init__(self, token: dict) -> None:
        self._token = token

    async def authorize_access_token(self, _request: object) -> dict:
        return self._token


class _FakeClientNoUserinfoInToken:
    """A token with no embedded userinfo, forcing the userinfo HTTP call."""

    def __init__(self, userinfo_error: Exception) -> None:
        self._userinfo_error = userinfo_error

    async def authorize_access_token(self, _request: object) -> dict:
        return {"access_token": "at"}

    async def userinfo(self, **_kwargs: object) -> dict:
        raise self._userinfo_error


class TestOidcCallback:
    async def test_provisions_user_and_sets_session_cookie(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        token = {
            "userinfo": {
                "email": "alice@example.com",
                "email_verified": True,
                "sub": "okta|123",
                "name": "Alice",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )

            assert response.status_code == 303
            set_cookie = response.headers.get("set-cookie")
            assert set_cookie is not None and "switch_auth=" in set_cookie
            # Signing in selects a workspace only from the user's *current*
            # memberships — here, the one just created. Signing in is the
            # recovery path out of a selection that has gone stale (a removed
            # member is 403'd on every request until something mints a claim
            # they can use), so it must never carry a previous claim forward
            # unchecked (CHOO-2723).
            assert _tenant_claim(set_cookie) == TENANT_ZERO_ID

            user = await UserStore().get_by_email(session, "alice@example.com")
            assert user is not None
            assert user.role == "user"
            assert user.password_hash is None
            assert user.metadata_ is None
            linked = await UserStore().get_by_oidc_identity(
                session, iss="https://idp.example", sub="okta|123"
            )
            assert linked is not None and linked.id == user.id

    @pytest.mark.parametrize("email_verified", [False, None, "false"])
    async def test_unverified_email_is_rejected(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        email_verified: object,
    ) -> None:
        # An absent claim is as untrusted as an explicit false.
        claims: dict[str, object] = {
            "email": "mallory@example.com",
            "sub": "okta|9",
            "name": "Mallory",
        }
        if email_verified is not None:
            claims["email_verified"] = email_verified
        token = {"userinfo": claims}
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 401

    @pytest.mark.parametrize("email_verified", [False, None, "false"])
    async def test_unverified_email_provisions_when_check_disabled(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        email_verified: object,
    ) -> None:
        # Okta's org authorization server reports false (or omits the claim)
        # for directory-provisioned users, so a deployment that vouches for its
        # IdP's addresses must be able to opt out.
        claims: dict[str, object] = {
            "email": "bob@example.com",
            "sub": "okta|55",
            "name": "Bob",
        }
        if email_verified is not None:
            claims["email_verified"] = email_verified
        monkeypatch.setattr(
            oidc_routes, "_client", lambda: _FakeClient({"userinfo": claims})
        )

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(gateway_oidc_require_email_verified=False),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )

            assert response.status_code == 303
            user = await UserStore().get_by_email(session, "bob@example.com")
            assert user is not None
            linked = await UserStore().get_by_oidc_identity(
                session, iss="https://idp.example", sub="okta|55"
            )
            assert linked is not None and linked.id == user.id

    async def test_missing_email_claim_still_rejected_when_check_disabled(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Opting out of the verified-email check must not weaken anything else.
        token = {"userinfo": {"sub": "okta|56", "email_verified": False}}
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(gateway_oidc_require_email_verified=False),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 401

    async def test_email_collision_still_rejected_when_check_disabled(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # The takeover guard is independent of the verified-email check.
        async with session_factory() as session:
            await UserStore().create(
                session,
                User(
                    name="Admin",
                    email="admin2@example.com",
                    role="admin",
                    password_hash=hash_password("pw"),
                ),
            )
            await session.commit()

        token = {
            "userinfo": {
                "email": "admin2@example.com",
                "email_verified": False,
                "sub": "okta|attacker2",
                "name": "Not Admin",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(gateway_oidc_require_email_verified=False),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 409

    async def test_verified_email_links_to_existing_account(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A verified token whose email matches an existing (password) account
        # but whose subject does not must land the login in that account,
        # rather than being refused: accounts are keyed on verified email, not
        # on login method.
        async with session_factory() as session:
            admin = User(
                name="Admin",
                email="admin@example.com",
                role="admin",
                password_hash=hash_password("pw"),
            )
            await UserStore().create(session, admin)
            await session.commit()
            admin_id = admin.id

        token = {
            "userinfo": {
                "email": "admin@example.com",
                "email_verified": True,
                "sub": "okta|second-device",
                "name": "Admin",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            assert response.status_code == 303

            user = await UserStore().get_by_email(session, "admin@example.com")
            assert user is not None
            assert user.id == admin_id
            # The link must not weaken password login on the account.
            assert user.password_hash is not None
            assert user.role == "admin"

            linked = await UserStore().get_by_oidc_identity(
                session, iss="https://idp.example", sub="okta|second-device"
            )
            assert linked is not None and linked.id == admin_id

    async def test_bound_identity_is_not_relinked_by_a_different_claimed_email(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Once (iss, sub) is linked, that binding decides the account on every
        # later login, regardless of what email the claim carries this time.
        token = {
            "userinfo": {
                "email": "carol@example.com",
                "email_verified": True,
                "sub": "okta|77",
                "name": "Carol",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            first = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            assert first.status_code == 303
            carol = await UserStore().get_by_email(session, "carol@example.com")
            assert carol is not None
            carol_id = carol.id

        other_email_token = {
            "userinfo": {
                "email": "carol-renamed@example.com",
                "email_verified": True,
                "sub": "okta|77",
                "name": "Carol",
            }
        }
        monkeypatch.setattr(
            oidc_routes, "_client", lambda: _FakeClient(other_email_token)
        )

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            assert response.status_code == 303
            linked = await UserStore().get_by_oidc_identity(
                session, iss="https://idp.example", sub="okta|77"
            )
            assert linked is not None and linked.id == carol_id
            assert linked.email == "carol@example.com"

    async def test_legacy_sub_only_identity_logs_in_when_check_disabled_despite_unverified_and_changed_email(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A deployment that disabled the verified-email check (its IdP never
        # emits the claim, e.g. an Okta org authorization server for
        # directory users) must keep logging a pre-existing sub-only identity
        # in — main did, by matching on sub alone regardless of email — even
        # though this account's email claim has since changed and is
        # unverified. Losing this would be both a lockout and, worse, a
        # silent fork into a brand-new "user"-role account.
        async with session_factory() as session:
            legacy = User(
                name="Legacy Admin",
                email="legacy-admin@example.com",
                role="admin",
                password_hash=None,
            )
            await UserStore().create(session, legacy)
            session.add(OidcIdentity(user_id=legacy.id, iss=None, sub="okta|legacy"))
            await session.commit()
            legacy_id = legacy.id

        token = {
            "userinfo": {
                "email": "legacy-admin-new-address@example.com",
                "email_verified": False,
                "sub": "okta|legacy",
                "name": "Legacy Admin",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(gateway_oidc_require_email_verified=False),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            assert response.status_code == 303

            user = await UserStore().get(session, legacy_id)
            assert user is not None
            assert user.role == "admin"
            assert user.email == "legacy-admin@example.com"

    async def test_identity_race_contention_maps_to_503(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A raced login is transient contention, not a rejected security
        # decision (that's OidcIdentityConflictError's 409) — it must not
        # surface as a generic 500, and it must be told apart from a 409 so
        # an operator can distinguish a retry storm from an attack signal.
        token = {
            "userinfo": {
                "email": "race@example.com",
                "email_verified": True,
                "sub": "okta|race-503",
                "name": "Race",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        class _AlwaysRacingStore:
            async def get_or_create_oidc_user(self, *args: object, **kwargs: object):
                raise OidcIdentityRaceError("raced twice in a row")

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=_AlwaysRacingStore(),  # type: ignore[arg-type]
                )
            assert exc.value.status_code == 503
            assert exc.value.headers is not None
            assert exc.value.headers.get("Retry-After") == "1"

    async def test_missing_email_claim_raises_401(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        token = {"userinfo": {"sub": "okta|123"}}  # no email
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 401

    async def test_userinfo_upstream_failure_maps_to_502(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A token with no embedded userinfo forces the fallback HTTP call to
        # the provider's userinfo endpoint; that call failing is the IdP's
        # fault, not the caller's, and must not surface as an unhandled 500.
        monkeypatch.setattr(
            oidc_routes,
            "_client",
            lambda: _FakeClientNoUserinfoInToken(
                httpx.ConnectError("connection refused")
            ),
        )

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 502
            assert exc.value.detail == "OIDC provider did not respond"

    async def test_userinfo_non_json_response_maps_to_502(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A 200 whose body isn't JSON (a proxy or captive portal sitting in
        # front of the provider) fails in resp.json(), not raise_for_status()
        # — still the provider's fault, so still a 502.
        monkeypatch.setattr(
            oidc_routes,
            "_client",
            lambda: _FakeClientNoUserinfoInToken(
                json.JSONDecodeError("Expecting value", "<html>not json</html>", 0)
            ),
        )

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 502
            assert exc.value.detail == "OIDC provider did not respond"

    async def test_missing_userinfo_endpoint_maps_to_503(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A provider whose discovery document has no userinfo_endpoint (it's
        # optional in the OIDC spec — WorkOS's User Management surface is one
        # such provider) combined with a token carrying no usable claims
        # leaves nowhere to read claims from. That's a configuration mistake
        # for this deployment, not a transient upstream fault — 503, not
        # 500, since it's diagnosed precisely enough to name rather than
        # unanticipated, and not a 502 since the provider didn't misbehave.
        monkeypatch.setattr(
            oidc_routes,
            "_client",
            lambda: _FakeClientNoUserinfoInToken(KeyError("userinfo_endpoint")),
        )

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 503
            assert exc.value.detail == (
                "OIDC provider has no userinfo endpoint and no claims were "
                "available from the token"
            )


class TestTheCallbackPlacesTheUserInATenant:
    """Sign-in provisions accounts, and an account with no membership can
    never sign in again (`gateway/auth.py` refuses to guess one). The callback
    binds tenant zero explicitly rather than letting `TenantScoped`'s fallback
    supply it — the same row today, but a decision rather than an accident.
    That is the `default_tenant` sign-up mode; `TestSignUpWithoutADefaultTenant`
    covers the others.
    """

    async def _memberships(
        self, session: AsyncSession, user_id: str
    ) -> list[TenantMember]:
        result = await session.execute(
            select(TenantMember).where(TenantMember.user_id == user_id)
        )
        return list(result.scalars().all())

    async def test_just_in_time_provisioning_creates_exactly_one_membership(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        token = {
            "userinfo": {
                "email": "jit@example.com",
                "email_verified": True,
                "sub": "okta|jit",
                "name": "Jit",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            user = await UserStore().get_by_email(session, "jit@example.com")
            assert user is not None
            memberships = await self._memberships(session, user.id)

        assert [m.tenant_id for m in memberships] == [TENANT_ZERO_ID]
        assert memberships[0].role == "member"

    async def test_linking_to_an_account_with_no_membership_repairs_it(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # An account that predates memberships: inserted directly, so it has
        # none. Linking is the only thing that reaches it, so if linking does
        # not give it one, nothing ever will.
        async with session_factory() as session:
            existing = User(
                name="Legacy",
                email="legacy@example.com",
                role="user",
                password_hash=hash_password("pw"),
            )
            session.add(existing)
            await session.commit()
            user_id = existing.id

        token = {
            "userinfo": {
                "email": "legacy@example.com",
                "email_verified": True,
                "sub": "okta|legacy",
                "name": "Legacy",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            memberships = await self._memberships(session, user_id)

        assert [m.tenant_id for m in memberships] == [TENANT_ZERO_ID]

    async def test_linking_to_an_account_that_has_one_does_not_add_a_second(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Two memberships is as broken as none: resolution refuses to pick.
        async with session_factory() as session:
            existing = User(
                name="Member",
                email="member@example.com",
                role="user",
                password_hash=hash_password("pw"),
            )
            await UserStore().create(session, existing)
            await session.commit()
            user_id = existing.id

        token = {
            "userinfo": {
                "email": "member@example.com",
                "email_verified": True,
                "sub": "okta|member",
                "name": "Member",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            memberships = await self._memberships(session, user_id)

        assert [m.tenant_id for m in memberships] == [TENANT_ZERO_ID]


def _verified_token(email: str, sub: str) -> dict:
    return {
        "userinfo": {
            "email": email,
            "email_verified": True,
            "sub": sub,
            "name": email.split("@", 1)[0],
        }
    }


async def _memberships(session: AsyncSession, user_id: str) -> list[TenantMember]:
    result = await session.execute(
        select(TenantMember).where(TenantMember.user_id == user_id)
    )
    return list(result.scalars().all())


class TestSignUpWithoutADefaultTenant:
    """In `open` and `invite_only` the callback places nobody: a new account
    arrives with no workspace and makes or accepts one itself. Tenant zero is
    an operator's workspace on such a server, not a lobby."""

    @pytest.mark.parametrize("mode", ["open", "invite_only"])
    async def test_a_new_account_has_no_membership_and_no_claim(
        self,
        mode: str,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        email = f"new-{mode.replace('_', '-')}@example.com"
        token = _verified_token(email, f"okta|new-{mode}")
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(gateway_signup_mode=mode),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            user = await UserStore().get_by_email(session, email)
            assert user is not None
            memberships = await _memberships(session, user.id)

        assert response.status_code == 303
        assert memberships == []
        set_cookie = response.headers.get("set-cookie")
        assert set_cookie is not None
        assert _tenant_claim(set_cookie) is None

    async def test_linking_a_verified_email_adds_no_membership(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async with session_factory() as session:
            existing = User(
                name="Unplaced",
                email="unplaced@example.com",
                role="user",
                password_hash=hash_password("pw"),
            )
            session.add(existing)
            await session.commit()
            user_id = existing.id

        token = _verified_token("unplaced@example.com", "okta|unplaced")
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(gateway_signup_mode="open"),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            identity = (
                await session.execute(
                    select(OidcIdentity).where(OidcIdentity.sub == "okta|unplaced")
                )
            ).scalar_one()
            memberships = await _memberships(session, user_id)

        assert identity.user_id == user_id
        assert memberships == []

    async def test_a_returning_account_lands_in_its_last_workspace(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        other = "oidc-returning-other"
        async with session_factory() as session:
            session.add(Tenant(id=other, slug=other, name=other))
            await session.flush()
            existing = User(
                name="Back",
                email="back@example.com",
                role="user",
                metadata_={"last_tenant_id": other},
            )
            session.add(existing)
            await session.flush()
            for tenant_id in (TENANT_ZERO_ID, other):
                session.add(
                    TenantMember(
                        tenant_id=tenant_id, user_id=existing.id, role="member"
                    )
                )
            await session.commit()

        token = _verified_token("back@example.com", "okta|back")
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=SimpleNamespace(session={}),  # type: ignore[arg-type]
                config=_config(gateway_signup_mode="open"),
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )

        set_cookie = response.headers.get("set-cookie")
        assert set_cookie is not None
        assert _tenant_claim(set_cookie) == other


class TestAuthConfigEndpoint:
    async def test_reports_enabled_oidc_and_label(self) -> None:
        config = _config(gateway_oidc_provider_label="Okta")
        result = await auth_config(config=config)
        assert result.oidc_enabled is True
        assert result.password_login_enabled is True
        assert result.oidc_provider_label == "Okta"

    async def test_reports_disabled_when_unconfigured(self) -> None:
        config = _config(
            gateway_oidc_issuer_url=None,
            gateway_oidc_client_id=None,
            gateway_oidc_client_secret=None,
            gateway_oidc_scopes=None,
            gateway_password_login_enabled=False,
        )
        result = await auth_config(config=config)
        assert result.oidc_enabled is False
        assert result.password_login_enabled is False

    async def test_reports_the_signup_mode(self) -> None:
        result = await auth_config(config=_config(gateway_signup_mode="invite_only"))
        assert result.signup_mode == "invite_only"


class _FakeAuthorize:
    """Stands in for the authlib OIDC client at the login."""

    def __init__(self) -> None:
        self.redirect_uris: list[str] = []

    async def authorize_redirect(
        self, _request: object, redirect_uri: str, **_params: str
    ) -> RedirectResponse:
        self.redirect_uris.append(redirect_uri)
        return RedirectResponse("https://idp.example/authorize", status_code=302)


class TestTheLoginStartsOnTheCallbacksHost:
    """The flow's state cookie must be on the host the provider returns to.

    A server serving its dashboard on its own address may still have a separate
    dashboard host that the identity provider returns to; a login begun on the
    server's own host is first sent there.
    """

    _CALLBACK = "https://switch-dashboard.example.com/gateway/auth/oidc/callback"

    def _client(
        self,
        monkeypatch: pytest.MonkeyPatch,
        host: str,
        redirect_url: str | None,
    ) -> tuple[TestClient, _FakeAuthorize]:
        fake = _FakeAuthorize()
        monkeypatch.setattr(oidc_routes, "_client", lambda: fake)
        config = _config(gateway_oidc_redirect_url=redirect_url)
        gateway = FastAPI()
        gateway.include_router(oidc_routes.router)
        gateway.dependency_overrides[get_config] = lambda: config
        gateway.add_middleware(SessionMiddleware, secret_key="test")
        app = FastAPI()
        app.mount("/gateway", gateway)
        return TestClient(app, base_url=host, follow_redirects=False), fake

    def test_a_login_on_another_host_is_sent_to_the_callbacks(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, fake = self._client(
            monkeypatch, "https://switch.example.com", self._CALLBACK
        )
        response = client.get("/gateway/auth/oidc/login")
        assert response.status_code == 302
        assert response.headers["location"] == (
            "https://switch-dashboard.example.com/gateway/auth/oidc/login"
            "?on_callback_host=1"
        )
        assert fake.redirect_uris == []

    def test_the_sign_ins_own_parameters_go_with_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Switch Console's hand-back to this computer, and a sign-in option,
        # must reach the host the sign-in really starts on.
        client, fake = self._client(
            monkeypatch, "https://switch.example.com", self._CALLBACK
        )
        response = client.get(
            "/gateway/auth/oidc/login",
            params={
                "provider": "google",
                "return_to": "http://127.0.0.1:5123/switch-sign-in",
                "state": "s" * 16,
                "challenge": "c" * 43,
            },
        )
        location = urlsplit(response.headers["location"])
        assert (location.netloc, location.path) == (
            "switch-dashboard.example.com",
            "/gateway/auth/oidc/login",
        )
        assert parse_qs(location.query) == {
            "provider": ["google"],
            "return_to": ["http://127.0.0.1:5123/switch-sign-in"],
            "state": ["s" * 16],
            "challenge": ["c" * 43],
            "on_callback_host": ["1"],
        }
        assert fake.redirect_uris == []

    def test_a_login_on_the_callbacks_host_starts_there(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, fake = self._client(
            monkeypatch, "https://switch-dashboard.example.com", self._CALLBACK
        )
        response = client.get("/gateway/auth/oidc/login")
        assert response.headers["location"] == "https://idp.example/authorize"
        assert fake.redirect_uris == [self._CALLBACK]

    def test_another_port_on_the_same_host_is_the_same_host(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A cookie is shared across ports, and a proxy may drop the port from
        # the Host header; sending the browser on would only loop.
        client, fake = self._client(
            monkeypatch,
            "http://localhost:8000",
            "http://localhost:3000/gateway/auth/oidc/callback",
        )
        client.get("/gateway/auth/oidc/login")
        assert fake.redirect_uris == [
            "http://localhost:3000/gateway/auth/oidc/callback"
        ]

    def test_a_proxy_rewriting_the_host_costs_one_hop_not_a_loop(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        client, fake = self._client(
            monkeypatch, "http://switch-core:8000", self._CALLBACK
        )
        with caplog.at_level("WARNING", logger=oidc_routes.__name__):
            response = client.get("/gateway/auth/oidc/login?on_callback_host=1")
        assert response.headers["location"] == "https://idp.example/authorize"
        assert fake.redirect_uris == [self._CALLBACK]
        assert "rewriting the Host header" in caplog.text

    def test_without_a_configured_callback_the_login_starts_where_it_is(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client, fake = self._client(monkeypatch, "https://switch.example.com", None)
        client.get("/gateway/auth/oidc/login")
        assert fake.redirect_uris == [
            "https://switch.example.com/gateway/auth/oidc/callback"
        ]


_GOOGLE = {"id": "google", "label": "Google", "params": {"provider": "GoogleOAuth"}}
_VERIFIER = "v" * 43


class _FakeAuthorizeClient:
    """Records what the login route asks the provider for."""

    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def authorize_redirect(
        self, _request: object, redirect_uri: str, **params: str
    ) -> str:
        self.calls.append({"redirect_uri": redirect_uri, **params})
        return "redirected"


def _login_request() -> SimpleNamespace:
    return SimpleNamespace(session={}, url_for=lambda _name: "https://gw/callback")


class TestLoginOptionsAndHandoff:
    async def test_auth_config_lists_the_login_options(self) -> None:
        result = await auth_config(config=_config(gateway_oidc_login_options=[_GOOGLE]))
        assert [(o.id, o.label) for o in result.oidc_login_options] == [
            ("google", "Google")
        ]
        assert result.oidc_browser_handoff is True

    def test_an_option_may_not_set_the_clients_own_parameters(self) -> None:
        with pytest.raises(ValueError, match="redirect_uri"):
            _config(
                gateway_oidc_login_options=[
                    {
                        "id": "x",
                        "label": "X",
                        "params": {"redirect_uri": "https://evil"},
                    }
                ]
            )

    async def test_an_option_sends_its_parameters_to_the_provider(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client = _FakeAuthorizeClient()
        monkeypatch.setattr(oidc_routes, "_client", lambda: client)
        await oidc_routes.oidc_login(
            request=_login_request(),  # type: ignore[arg-type]
            config=_config(gateway_oidc_login_options=[_GOOGLE]),
            provider="google",
        )
        assert client.calls == [
            {"redirect_uri": "https://gw/callback", "provider": "GoogleOAuth"}
        ]

    async def test_an_unknown_option_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeAuthorizeClient())
        with pytest.raises(HTTPException) as exc:
            await oidc_routes.oidc_login(
                request=_login_request(),  # type: ignore[arg-type]
                config=_config(),
                provider="google",
            )
        assert exc.value.status_code == 400

    @pytest.mark.parametrize(
        "return_to",
        [
            "https://127.0.0.1:5000/switch-sign-in",
            "http://evil.example:5000/switch-sign-in",
            "http://127.0.0.1/switch-sign-in",
            "http://127.0.0.1:5000/elsewhere",
            "http://user@127.0.0.1:5000/switch-sign-in",
            "http://127.0.0.1:5000/switch-sign-in?next=x",
        ],
    )
    async def test_the_code_only_goes_back_to_this_computer(
        self, monkeypatch: pytest.MonkeyPatch, return_to: str
    ) -> None:
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeAuthorizeClient())
        with pytest.raises(HTTPException) as exc:
            await oidc_routes.oidc_login(
                request=_login_request(),  # type: ignore[arg-type]
                config=_config(),
                return_to=return_to,
                state="s" * 32,
                challenge=oidc_routes._challenge_of(_VERIFIER),
            )
        assert exc.value.status_code == 400

    async def test_a_handed_back_sign_in_trades_its_code_for_a_session(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        config = _config()
        request = _login_request()
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeAuthorizeClient())
        await oidc_routes.oidc_login(
            request=request,  # type: ignore[arg-type]
            config=config,
            return_to="http://127.0.0.1:5000/switch-sign-in",
            state="s" * 32,
            challenge=oidc_routes._challenge_of(_VERIFIER),
        )
        token = _verified_token("hand@example.com", "okta|hand")
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))
        async with session_factory() as session:
            response = await oidc_routes.oidc_callback(
                request=request,  # type: ignore[arg-type]
                config=config,
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
            # No cookie in the browser: the code goes back to the app.
            assert response.headers.get("set-cookie") is None
            location = response.headers["location"]
            assert location.startswith("http://127.0.0.1:5000/switch-sign-in?code=")
            assert f"state={'s' * 32}" in location
            code = httpx.URL(location).params["code"]

            wrong = oidc_routes.HandoffExchange(code=code, verifier="w" * 43)
            with pytest.raises(HTTPException):
                await oidc_routes.oidc_exchange(
                    req=wrong,
                    config=config,
                    session=session,
                    session_factory=session_factory,
                    user_store=UserStore(),
                )
            exchanged = await oidc_routes.oidc_exchange(
                req=oidc_routes.HandoffExchange(code=code, verifier=_VERIFIER),
                config=config,
                session=session,
                session_factory=session_factory,
                user_store=UserStore(),
            )
        set_cookie = exchanged.headers.get("set-cookie")
        assert set_cookie is not None and "switch_auth=" in set_cookie
