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
                session,
                iss=_ISS,
                email="new@example.com",
                name="New",
                sub="okta|9",
                email_verified=True,
            )
            await session.commit()
            assert user.role == "user"
            assert user.password_hash is None
            assert user.metadata_ is None

            again = await store.get_by_oidc_identity(session, iss=_ISS, sub="okta|9")
            assert again is not None and again.id == user.id

    async def test_same_identity_is_returned_and_keeps_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            first = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="a@example.com",
                name="A",
                sub="okta|1",
                email_verified=True,
            )
            await session.commit()
            first.role = "admin"
            await session.commit()

            again = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="a@example.com",
                name="A",
                sub="okta|1",
                email_verified=True,
            )
            assert again.id == first.id
            assert again.role == "admin"

    async def test_verified_email_links_to_existing_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The reversal this fix makes: someone who signed up with a password
        # and later signs in with an IdP sharing that verified email lands in
        # the same account, not a second one.
        store = UserStore()
        async with session_factory() as session:
            existing = User(
                name="Pat",
                email="pat@example.com",
                role="user",
                password_hash="bcrypt-hash",
            )
            await store.create(session, existing)
            await session.commit()

            linked = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="pat@example.com",
                name="Pat",
                sub="okta|42",
                email_verified=True,
            )
            await session.commit()

            assert linked.id == existing.id
            # Password login must not be weakened by the link.
            assert linked.password_hash == "bcrypt-hash"

            by_identity = await store.get_by_oidc_identity(
                session, iss=_ISS, sub="okta|42"
            )
            assert by_identity is not None and by_identity.id == existing.id

    async def test_two_subjects_same_issuer_can_both_link_to_one_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A user may hold several identities (e.g. two Google accounts
        # forwarding to one mailbox at the IdP) without either one being able
        # to impersonate the other: each keeps its own (iss, sub) row and
        # both resolve back to the same account, never to each other.
        store = UserStore()
        async with session_factory() as session:
            first = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="shared@example.com",
                name="Shared",
                sub="okta|1",
                email_verified=True,
            )
            await session.commit()

            second = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="shared@example.com",
                name="Shared",
                sub="okta|2",
                email_verified=True,
            )
            await session.commit()

            assert second.id == first.id
            assert (
                await store.get_by_oidc_identity(session, iss=_ISS, sub="okta|1")
            ).id == first.id  # type: ignore[union-attr]
            assert (
                await store.get_by_oidc_identity(session, iss=_ISS, sub="okta|2")
            ).id == first.id  # type: ignore[union-attr]

    async def test_unverified_email_collision_with_different_identity_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The takeover this closes: an existing (password) admin must not be
        # handed to an OIDC login that merely shares its email with a
        # different, unverified subject.
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
                    email_verified=False,
                )

    async def test_identity_already_bound_elsewhere_is_never_relinked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Once (iss, sub) is bound, that lookup — not the email on the
        # incoming claim — decides the account, so a stale or changed email on
        # the same subject can never move the identity to someone else's row.
        store = UserStore()
        async with session_factory() as session:
            owner = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="owner@example.com",
                name="Owner",
                sub="okta|owned",
                email_verified=True,
            )
            await session.commit()

            other = User(
                name="Other",
                email="other@example.com",
                role="user",
                password_hash="bcrypt-hash",
            )
            await store.create(session, other)
            await session.commit()

            again = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="other@example.com",
                name="Owner",
                sub="okta|owned",
                email_verified=True,
            )
            assert again.id == owner.id
