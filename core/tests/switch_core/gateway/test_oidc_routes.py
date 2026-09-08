from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.gateway.oidc_routes as oidc_routes
from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, OidcIdentity, TenantMember, User
from switch_core.db.stores.user_store import OidcIdentityRaceError, UserStore
from switch_core.gateway.auth import hash_password
from switch_core.gateway.auth_routes import auth_config


def _config(**overrides: object) -> SwitchConfig:
    base: dict[str, object] = dict(
        db_host="h",
        db_port="5432",
        db_user="u",
        db_password="p",
        db_name="d",
        matrix_server_name="m",
        agent_registration_token="t",
        jwt_secret_key="secret",
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                user_store=UserStore(),
            )

            assert response.status_code == 303
            set_cookie = response.headers.get("set-cookie")
            assert set_cookie is not None and "switch_auth=" in set_cookie

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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(gateway_oidc_require_email_verified=False),
                session=session,
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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(gateway_oidc_require_email_verified=False),
                    session=session,
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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(gateway_oidc_require_email_verified=False),
                    session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(gateway_oidc_require_email_verified=False),
                session=session,
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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 502

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
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 502

    async def test_missing_userinfo_endpoint_maps_to_503(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A provider whose discovery document has no userinfo_endpoint (it's
        # optional in the OIDC spec — WorkOS's User Management surface is one
        # such provider) combined with a token carrying no id_token leaves
        # nowhere to read claims from. That's a configuration mistake for
        # this deployment, not a transient upstream fault — 503, not 500,
        # since it's diagnosed precisely enough to name rather than
        # unanticipated, and not a 502 since the provider didn't misbehave.
        monkeypatch.setattr(
            oidc_routes,
            "_client",
            lambda: _FakeClientNoUserinfoInToken(KeyError("userinfo_endpoint")),
        )

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 503
            assert exc.value.detail == (
                "OIDC provider has no userinfo endpoint and issued no id_token"
            )


class TestTheCallbackPlacesTheUserInATenant:
    """Sign-in provisions accounts, and an account with no membership can
    never sign in again (`gateway/auth.py` refuses to guess one). The callback
    binds tenant zero explicitly rather than letting `TenantScoped`'s fallback
    supply it — the same row today, but a decision rather than an accident,
    and the line a later sign-up phase changes.
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
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
                request=SimpleNamespace(),  # type: ignore[arg-type]
                config=_config(),
                session=session,
                user_store=UserStore(),
            )
            memberships = await self._memberships(session, user_id)

        assert [m.tenant_id for m in memberships] == [TENANT_ZERO_ID]


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
