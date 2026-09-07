from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import User
from switch_core.db.stores.user_store import OidcIdentityConflictError, UserStore

_ISS = "https://idp.example.com"


class TestGetOrCreateOidcUser:
    async def test_creates_new_user_as_plain_user(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            user = await store.get_or_create_oidc_user(
                session, iss=_ISS, email="new@example.com", name="New", sub="okta|9"
            )
            await session.commit()
            assert user.role == "user"
            assert user.password_hash is None
            assert user.metadata_ == {"oidc_iss": _ISS, "oidc_sub": "okta|9"}

    async def test_same_identity_is_returned_and_keeps_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            first = await store.get_or_create_oidc_user(
                session, iss=_ISS, email="a@example.com", name="A", sub="okta|1"
            )
            await session.commit()
            first.role = "admin"
            await session.commit()

            again = await store.get_or_create_oidc_user(
                session, iss=_ISS, email="a@example.com", name="A", sub="okta|1"
            )
            assert again.id == first.id
            assert again.role == "admin"

    async def test_email_collision_with_different_identity_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The takeover this fix closes: an existing (password) admin must not be
        # returned to an OIDC login that merely shares its email with a
        # different subject.
        store = UserStore()
        async with session_factory() as session:
            admin = User(
                name="Admin",
                email="admin@example.com",
                role="admin",
                password_hash="bcrypt-hash",
            )
            await store.create(session, admin)
            await session.commit()

            with pytest.raises(OidcIdentityConflictError):
                await store.get_or_create_oidc_user(
                    session,
                    iss=_ISS,
                    email="admin@example.com",
                    name="Different",
                    sub="okta|1",
                )

    async def test_legacy_row_without_iss_matches_by_sub_and_backfills(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            legacy = User(
                name="Legacy",
                email="legacy@example.com",
                role="user",
                password_hash=None,
                metadata_={"oidc_sub": "okta|7"},
            )
            await store.create(session, legacy)
            await session.commit()

            got = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="legacy@example.com",
                name="Legacy",
                sub="okta|7",
            )
            assert got.id == legacy.id
            assert got.metadata_ == {"oidc_sub": "okta|7", "oidc_iss": _ISS}
