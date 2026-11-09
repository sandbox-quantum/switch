"""The seeded admin when password login is off.

`GATEWAY_ADMIN_PASSWORD` is the admin's password-login credential, so a
deployment that signs in only through OIDC need not set it. The admin is then
seeded with no password, and the first OIDC sign-in with that verified address
links to it.
"""

from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.config import SwitchConfig
from switch_core.db.models import TENANT_ZERO_ID, OidcIdentity, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.user_store import UserStore
from switch_core.main import _seed_admin_user

pytestmark = pytest.mark.no_ambient_tenant

ADMIN_EMAIL = "admin@switch.local"


def _config(*, password: str | None, password_login: bool) -> SwitchConfig:
    return SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        id_server_name="test",
        agent_registration_token="unused",
        secret_keys="test:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        gateway_admin_email=ADMIN_EMAIL,
        gateway_admin_password=password,
        gateway_password_login_enabled=password_login,
    )


async def _admin(session_factory: async_sessionmaker[AsyncSession]) -> User:
    async with session_factory() as session:
        return (
            await session.execute(select(User).where(User.email == ADMIN_EMAIL))
        ).scalar_one()


class TestConfig:
    def test_password_login_requires_the_password(self) -> None:
        with pytest.raises(ValidationError, match="GATEWAY_ADMIN_PASSWORD is required"):
            _config(password=None, password_login=True)

    def test_an_empty_password_counts_as_none(self) -> None:
        with pytest.raises(ValidationError, match="GATEWAY_ADMIN_PASSWORD is required"):
            _config(password="", password_login=True)

    def test_without_password_login_the_password_may_be_absent(self) -> None:
        config = _config(password=None, password_login=False)
        assert config.gateway_admin_password is None


class TestSeeding:
    async def test_the_admin_is_seeded_without_a_password(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_admin_user(
            session_factory, UserStore(), _config(password=None, password_login=False)
        )

        admin = await _admin(session_factory)
        assert admin.role == "admin"
        assert admin.password_hash is None

    async def test_a_password_set_later_reaches_an_admin_seeded_without_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_admin_user(
            session_factory, UserStore(), _config(password=None, password_login=False)
        )
        await _seed_admin_user(
            session_factory,
            UserStore(),
            _config(password="s3cret-pw", password_login=True),
        )

        assert (await _admin(session_factory)).password_hash is not None

    async def test_the_first_oidc_sign_in_links_to_the_seeded_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_admin_user(
            session_factory, UserStore(), _config(password=None, password_login=False)
        )
        seeded = await _admin(session_factory)

        async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
            user, _ = await UserStore().get_or_create_oidc_user(
                session,
                iss="https://idp.example.com",
                email=ADMIN_EMAIL,
                name="Admin",
                sub="admin-subject",
                email_verified=True,
                join_tenant=True,
                link_by_email=True,
            )
            await session.commit()

        assert user.id == seeded.id
        assert user.role == "admin"
        async with session_factory() as session:
            linked = (
                await session.execute(
                    select(OidcIdentity.user_id).where(
                        OidcIdentity.sub == "admin-subject"
                    )
                )
            ).scalar_one()
        assert linked == seeded.id

    async def test_an_unused_password_is_warned_about(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="switch_core.main"):
            await _seed_admin_user(
                session_factory,
                UserStore(),
                _config(password="hunter2", password_login=False),
            )

        assert any(
            "GATEWAY_ADMIN_PASSWORD is set but password login is disabled"
            in r.getMessage()
            for r in caplog.records
        )

    async def test_no_warning_while_password_login_is_on(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.WARNING, logger="switch_core.main"):
            await _seed_admin_user(
                session_factory,
                UserStore(),
                _config(password="hunter2", password_login=True),
            )

        assert not any(
            "GATEWAY_ADMIN_PASSWORD" in r.getMessage() for r in caplog.records
        )
        assert (await _admin(session_factory)).password_hash is not None
