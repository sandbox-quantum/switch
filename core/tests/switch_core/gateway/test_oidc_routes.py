from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import switch_core.gateway.oidc_routes as oidc_routes
from switch_core.config import SwitchConfig
from switch_core.db.models import User
from switch_core.db.stores.user_store import UserStore
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
    )
    base.update(overrides)
    return SwitchConfig(**base)  # type: ignore[arg-type]


class _FakeClient:
    """Stands in for the authlib OIDC client at the callback."""

    def __init__(self, token: dict) -> None:
        self._token = token

    async def authorize_access_token(self, _request: object) -> dict:
        return self._token


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
            assert user.metadata_ == {
                "oidc_iss": "https://idp.example",
                "oidc_sub": "okta|123",
            }

    async def test_unverified_email_is_rejected(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        token = {
            "userinfo": {
                "email": "mallory@example.com",
                "email_verified": False,
                "sub": "okta|9",
                "name": "Mallory",
            }
        }
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

    async def test_email_collision_with_existing_account_is_rejected(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A verified token whose email matches an existing account but whose
        # subject does not must not take that account over.
        from switch_core.gateway.auth import hash_password

        async with session_factory() as session:
            admin = User(
                name="Admin",
                email="admin@example.com",
                role="admin",
                password_hash=hash_password("pw"),
            )
            await UserStore().create(session, admin)
            await session.commit()

        token = {
            "userinfo": {
                "email": "admin@example.com",
                "email_verified": True,
                "sub": "okta|attacker",
                "name": "Not Admin",
            }
        }
        monkeypatch.setattr(oidc_routes, "_client", lambda: _FakeClient(token))

        async with session_factory() as session:
            with pytest.raises(HTTPException) as exc:
                await oidc_routes.oidc_callback(
                    request=SimpleNamespace(),  # type: ignore[arg-type]
                    config=_config(),
                    session=session,
                    user_store=UserStore(),
                )
            assert exc.value.status_code == 409

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
            gateway_password_login_enabled=False,
        )
        result = await auth_config(config=config)
        assert result.oidc_enabled is False
        assert result.password_login_enabled is False
