from __future__ import annotations

import logging

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, OidcIdentity, TenantMember, User
from switch_core.db.stores.user_store import (
    OidcIdentityConflictError,
    OidcIdentityRaceError,
    UserStore,
)

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
                join_tenant=True,
            )
            await session.commit()
            assert user.role == "user"
            assert user.password_hash is None
            assert user.metadata_ is None

            again = await store.get_by_oidc_identity(session, iss=_ISS, sub="okta|9")
            assert again is not None and again.id == user.id

    async def test_new_user_email_is_stored_lowercase(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # An account this method creates should not add a new case variant of
        # its own, even though the lookup that precedes creation is already
        # case-insensitive and would have caught a collision either way.
        store = UserStore()
        async with session_factory() as session:
            user = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="New.Person@Example.com",
                name="New",
                sub="okta|10",
                email_verified=True,
                join_tenant=True,
            )
            await session.commit()
            assert user.email == "new.person@example.com"

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
                join_tenant=True,
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
                join_tenant=True,
            )
            assert again.id == first.id
            assert again.role == "admin"

    async def test_verified_email_links_to_existing_account(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Accounts are keyed on verified email, not on login method: a
        # password sign-up that later signs in with an IdP sharing that
        # verified email lands in the same account, not a second one.
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
                join_tenant=True,
            )
            await session.commit()

            assert linked.id == existing.id
            # Password login must not be weakened by the link.
            assert linked.password_hash == "bcrypt-hash"

            by_identity = await store.get_by_oidc_identity(
                session, iss=_ISS, sub="okta|42"
            )
            assert by_identity is not None and by_identity.id == existing.id

    async def test_verified_email_links_case_insensitively(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # Accounts must be the same account regardless of how the mailbox's
        # case was typed at signup versus how the IdP asserts it.
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
                email="Pat@Example.com",
                name="Pat",
                sub="okta|43",
                email_verified=True,
                join_tenant=True,
            )
            await session.commit()

            assert linked.id == existing.id

    async def test_pre_existing_case_duplicate_emails_resolve_deterministically_and_log(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        # users.email is still case-sensitively unique, so two rows differing
        # only by case can exist from before get_by_email compared
        # case-insensitively (or from a path that bypasses this store
        # entirely). A login must not crash on that, and it must not silently
        # guess between two real accounts either — a pick that could change
        # between calls, or that nobody is ever told about, is worse than a
        # stable pick that gets logged. This asserts stability and disclosure,
        # not "the right one": which id sorts lowest is arbitrary, so the test
        # doesn't assign either row a role that implies it should win.
        store = UserStore()
        async with session_factory() as session:
            first = User(name="First", email="dup@example.com", role="user")
            second = User(name="Second", email="Dup@Example.com", role="user")
            await store.create(session, first)
            await store.create(session, second)
            await session.commit()
            expected = min(first.id, second.id)

            with caplog.at_level(
                logging.ERROR, logger="switch_core.db.stores.user_store"
            ):
                # Called twice: the point being tested is that this is a
                # stable pick, not one that happens to vary between calls.
                first_call = await store.get_by_email(session, "DUP@EXAMPLE.COM")
                second_call = await store.get_by_email(session, "dup@example.com")

            assert first_call is not None and first_call.id == expected
            assert second_call is not None and second_call.id == expected
            assert any(
                first.id in record.message and second.id in record.message
                for record in caplog.records
            )

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
                join_tenant=True,
            )
            await session.commit()

            second = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="shared@example.com",
                name="Shared",
                sub="okta|2",
                email_verified=True,
                join_tenant=True,
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
        # An unverified email is attacker-controllable, so a collision with an
        # existing (password) account must be refused, never linked.
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
                    join_tenant=True,
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
                join_tenant=True,
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
                join_tenant=True,
            )
            assert again.id == owner.id

    async def test_legacy_identity_without_issuer_matches_by_sub_and_backfills(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A row migrated from before the issuer was tracked at all (oidc_sub
        # only) must keep resolving on sub alone, exactly as it did when this
        # identity lived in users.metadata instead of its own table.
        store = UserStore()
        async with session_factory() as session:
            legacy_user = User(
                name="Legacy",
                email="legacy@example.com",
                role="user",
                password_hash=None,
            )
            await store.create(session, legacy_user)
            session.add(OidcIdentity(user_id=legacy_user.id, iss=None, sub="okta|7"))
            await session.commit()

            got = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="legacy@example.com",
                name="Legacy",
                sub="okta|7",
                email_verified=True,
                join_tenant=True,
            )
            assert got.id == legacy_user.id

            result = await session.execute(
                select(OidcIdentity).where(OidcIdentity.sub == "okta|7")
            )
            identity = result.scalar_one()
            assert identity.iss == _ISS

    async def test_legacy_identity_without_issuer_resolves_even_if_email_changed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A deployment with GATEWAY_OIDC_REQUIRE_EMAIL_VERIFIED=false (e.g. an
        # Okta org authorization server, which never emits email_verified for
        # directory users) matched a legacy sub-only row before this identity
        # had its own table, regardless of email. That must still hold: the
        # account is not orphaned, and no second account is forked, just
        # because the claimed email no longer matches.
        store = UserStore()
        async with session_factory() as session:
            legacy_admin = User(
                name="Admin",
                email="admin-old@example.com",
                role="admin",
                password_hash=None,
            )
            await store.create(session, legacy_admin)
            session.add(OidcIdentity(user_id=legacy_admin.id, iss=None, sub="okta|8"))
            await session.commit()

            got = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="admin-new@example.com",
                name="Admin",
                sub="okta|8",
                email_verified=False,
                join_tenant=True,
            )
            assert got.id == legacy_admin.id
            assert got.role == "admin"
            assert got.email == "admin-old@example.com"

    async def test_linking_an_identity_is_logged(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        store = UserStore()
        with caplog.at_level(
            logging.WARNING, logger="switch_core.db.stores.user_store"
        ):
            async with session_factory() as session:
                user = await store.get_or_create_oidc_user(
                    session,
                    iss=_ISS,
                    email="logged@example.com",
                    name="Logged",
                    sub="okta|logged",
                    email_verified=True,
                    join_tenant=True,
                )
                await session.commit()

        assert any(
            _ISS in record.message
            and "okta|logged" in record.message
            and user.id in record.message
            for record in caplog.records
        )

    async def test_iss_sub_unique_constraint_is_enforced_at_the_db_level(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            first = User(name="A", email="a@example.com", role="user")
            second = User(name="B", email="b@example.com", role="user")
            await store.create(session, first)
            await store.create(session, second)
            session.add(OidcIdentity(user_id=first.id, iss=_ISS, sub="dup"))
            await session.commit()

            session.add(OidcIdentity(user_id=second.id, iss=_ISS, sub="dup"))
            with pytest.raises(IntegrityError):
                await session.commit()

    async def test_null_issuer_sub_unique_constraint_is_enforced_at_the_db_level(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # UNIQUE(iss, sub) does not constrain a NULL issuer at all — Postgres
        # never treats two NULLs as equal — so this must be a separate,
        # partial index; without it, two different users could each hold a
        # legacy identity for the same subject and a lookup would resolve to
        # whichever one it saw first.
        store = UserStore()
        async with session_factory() as session:
            first = User(name="A", email="legacy-a@example.com", role="user")
            second = User(name="B", email="legacy-b@example.com", role="admin")
            await store.create(session, first)
            await store.create(session, second)
            session.add(OidcIdentity(user_id=first.id, iss=None, sub="dup-legacy"))
            await session.commit()

            session.add(OidcIdentity(user_id=second.id, iss=None, sub="dup-legacy"))
            with pytest.raises(IntegrityError):
                await session.commit()

    async def test_race_exhausted_twice_raises_a_distinct_contention_error(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # A single retry is meant for one raced write, not a store that keeps
        # lying about what exists; a second collision must raise loudly under
        # its own error type rather than being retried forever or mistaken
        # for the security-rejection OidcIdentityConflictError.
        store = UserStore()
        async with session_factory() as winner_session:
            await store.get_or_create_oidc_user(
                winner_session,
                iss=_ISS,
                email="always-races@example.com",
                name="Winner",
                sub="okta|always-races",
                email_verified=True,
                join_tenant=True,
            )
            await winner_session.commit()

        async with session_factory() as session:

            async def always_misses(sess: AsyncSession, *, iss: str, sub: str):
                return None

            monkeypatch.setattr(store, "get_by_oidc_identity", always_misses)

            with pytest.raises(OidcIdentityRaceError):
                await store.get_or_create_oidc_user(
                    session,
                    iss=_ISS,
                    email="someone-else-again@example.com",
                    name="Loser",
                    sub="okta|always-races",
                    email_verified=True,
                    join_tenant=True,
                )

    async def test_concurrent_creation_of_the_same_identity_resolves_to_the_winner(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Two logins racing to provision the same brand-new (iss, sub) collide
        # on the unique constraint; the loser must resolve to the winner's
        # row instead of surfacing that as a 500.
        store = UserStore()
        async with session_factory() as winner_session:
            winner = await store.get_or_create_oidc_user(
                winner_session,
                iss=_ISS,
                email="race@example.com",
                name="Race",
                sub="okta|race",
                email_verified=True,
                join_tenant=True,
            )
            await winner_session.commit()

        async with session_factory() as session:
            original_lookup = store.get_by_oidc_identity
            calls = {"n": 0}

            async def lookup_that_misses_once(
                sess: AsyncSession, *, iss: str, sub: str
            ):
                calls["n"] += 1
                if calls["n"] == 1:
                    return None
                return await original_lookup(sess, iss=iss, sub=sub)

            monkeypatch.setattr(store, "get_by_oidc_identity", lookup_that_misses_once)

            resolved = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="someone-else@example.com",
                name="Other",
                sub="okta|race",
                email_verified=True,
                join_tenant=True,
            )
            assert resolved.id == winner.id

    async def test_concurrent_new_email_provisioning_resolves_to_one_account(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Two logins racing to provision the same brand-new email collide on
        # the email unique constraint; the loser must link its identity to
        # the winner's row instead of surfacing that as a 500.
        store = UserStore()
        async with session_factory() as winner_session:
            winner = await store.get_or_create_oidc_user(
                winner_session,
                iss=_ISS,
                email="shared-new@example.com",
                name="First",
                sub="okta|first",
                email_verified=True,
                join_tenant=True,
            )
            await winner_session.commit()

        async with session_factory() as session:
            original_lookup = store.get_by_email
            calls = {"n": 0}

            async def lookup_that_misses_once(sess: AsyncSession, email: str):
                calls["n"] += 1
                if calls["n"] == 1:
                    return None
                return await original_lookup(sess, email)

            monkeypatch.setattr(store, "get_by_email", lookup_that_misses_once)

            resolved = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="shared-new@example.com",
                name="Second",
                sub="okta|second",
                email_verified=True,
                join_tenant=True,
            )
            assert resolved.id == winner.id

            for sub in ("okta|first", "okta|second"):
                identity = await store.get_by_oidc_identity(session, iss=_ISS, sub=sub)
                assert identity is not None and identity.id == winner.id


async def _membership_count(session: AsyncSession, user_id: str) -> int:
    result = await session.execute(
        select(TenantMember).where(TenantMember.user_id == user_id)
    )
    return len(result.scalars().all())


class TestProvisioningWithoutJoiningATenant:
    """`join_tenant=False` is how an `open` or `invite_only` server signs
    people up: the account and its identity are made, and nothing places them
    in a workspace. It must hold with no tenant bound at all, since that is
    how the callback runs in those modes."""

    async def test_a_new_account_gets_its_identity_and_no_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            user = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="loose@example.com",
                name="Loose",
                sub="okta|loose",
                email_verified=True,
                join_tenant=False,
            )
            await session.commit()

            again = await store.get_by_oidc_identity(
                session, iss=_ISS, sub="okta|loose"
            )
            assert again is not None and again.id == user.id
            assert await _membership_count(session, user.id) == 0

    async def test_linking_an_existing_account_adds_no_membership(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            existing = User(name="Prior", email="prior@example.com", role="user")
            session.add(existing)
            await session.commit()

            user = await store.get_or_create_oidc_user(
                session,
                iss=_ISS,
                email="prior@example.com",
                name="Prior",
                sub="okta|prior",
                email_verified=True,
                join_tenant=False,
            )
            await session.commit()

            assert user.id == existing.id
            assert await _membership_count(session, user.id) == 0


class TestLastTenant:
    async def test_an_account_with_no_history_has_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            user = User(name="Fresh", email="fresh@example.com", role="user")
            session.add(user)
            await session.commit()
            assert UserStore().last_tenant_id(user) is None

    async def test_recording_keeps_the_rest_of_the_metadata(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = UserStore()
        async with session_factory() as session:
            user = User(
                name="Noted",
                email="noted@example.com",
                role="user",
                metadata_={"theme": "dark"},
            )
            session.add(user)
            await session.commit()
            user_id = user.id

            await store.record_last_tenant(session, user, TENANT_ZERO_ID)
            await session.commit()

        async with session_factory() as session:
            reloaded = await session.get(User, user_id)
            assert reloaded is not None
            assert store.last_tenant_id(reloaded) == TENANT_ZERO_ID
            assert reloaded.metadata_ == {
                "theme": "dark",
                "last_tenant_id": TENANT_ZERO_ID,
            }
