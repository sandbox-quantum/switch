from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_TYPE,
    BOOTSTRAP_LAST_SEEDED_HASH_META_KEY,
    BOOTSTRAP_OWNER_EMAIL,
    BOOTSTRAP_OWNER_MARKER_META_KEY,
    ensure_bootstrap_owner,
    resolve_registration_owner_id,
)
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.user_store import UserStore


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession], *, role: str
) -> str:
    async with session_factory() as session:
        user = User(name=role, email=f"{role}@test", role=role, password_hash="x")
        session.add(user)
        await session.commit()
        return user.id


class TestEnsureBootstrapOwner:
    async def test_creates_a_marked_non_admin_user_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        async with session_factory() as session:
            owner = await ensure_bootstrap_owner(session, user_store)
            await session.commit()
            assert owner.email == BOOTSTRAP_OWNER_EMAIL
            assert owner.role != "admin"
            assert (owner.metadata_ or {}).get(BOOTSTRAP_OWNER_MARKER_META_KEY) is True

        async with session_factory() as session:
            again = await ensure_bootstrap_owner(session, user_store)
            await session.commit()
            assert again.id == owner.id

    async def test_refuses_a_role_user_account_squatting_the_address(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The realistic squatter: an identity claimed this address — via
        OIDC JIT provisioning, or any other path — before bootstrap seeding
        ever ran. JIT provisioning always creates `role="user"`, so a role
        check alone would silently adopt it; only the creation marker this
        module stamps distinguishes a genuine bootstrap owner from one."""
        user_store = UserStore()
        async with session_factory() as session:
            session.add(User(name="squatter", email=BOOTSTRAP_OWNER_EMAIL, role="user"))
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(RuntimeError, match="cannot be proven"):
                await ensure_bootstrap_owner(session, user_store)

    async def test_backfills_the_marker_onto_a_row_created_before_it_existed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Upgrade path: a bootstrap owner created by an earlier commit of
        this same feature, before the marker existed, has no marker but does
        carry the last-seeded-hash key — a value only this module's own
        seeding step ever writes, so a squatter cannot have it. Must be
        healed in place, not refused, or upgrading past the commit that
        introduced the marker bricks every database that already ran this."""
        user_store = UserStore()
        async with session_factory() as session:
            session.add(
                User(
                    name=BOOTSTRAP_OWNER_EMAIL,
                    email=BOOTSTRAP_OWNER_EMAIL,
                    role="user",
                    metadata_={BOOTSTRAP_LAST_SEEDED_HASH_META_KEY: "some-hash"},
                )
            )
            await session.commit()

        async with session_factory() as session:
            owner = await ensure_bootstrap_owner(session, user_store)
            await session.commit()

        assert (owner.metadata_ or {}).get(BOOTSTRAP_OWNER_MARKER_META_KEY) is True
        assert (owner.metadata_ or {}).get(BOOTSTRAP_LAST_SEEDED_HASH_META_KEY) == (
            "some-hash"
        )

        async with session_factory() as session:
            persisted = await session.get(User, owner.id)
        assert persisted is not None
        assert (persisted.metadata_ or {}).get(BOOTSTRAP_OWNER_MARKER_META_KEY) is True

    async def test_refuses_a_marked_account_promoted_to_the_admin_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The role check as its own, independently-exercised guard: an
        otherwise-genuine account (it carries the marker) that has been
        given the admin role — e.g. a gateway admin editing it directly —
        must still be refused. Deliberately marked so this hits the role
        check specifically rather than the (already separately tested)
        missing-marker check."""
        user_store = UserStore()
        async with session_factory() as session:
            session.add(
                User(
                    name="promoted",
                    email=BOOTSTRAP_OWNER_EMAIL,
                    role="admin",
                    metadata_={BOOTSTRAP_OWNER_MARKER_META_KEY: True},
                )
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(RuntimeError, match="must never be an admin"):
                await ensure_bootstrap_owner(session, user_store)


class TestResolveRegistrationOwnerId:
    async def test_registration_key_resolves_to_its_own_user(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        user_id = await _make_user(session_factory, role="user")
        key = ApiKey(
            user_id=user_id,
            key_hash="h",
            encrypted_key="e",
            label="mine",
            type="registration",
        )
        async with session_factory() as session:
            owner_id = await resolve_registration_owner_id(session, user_store, key)
        assert owner_id == user_id

    async def test_bootstrap_key_resolves_to_the_bootstrap_owner_not_its_user_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        admin_id = await _make_user(session_factory, role="admin")
        async with session_factory() as session:
            bootstrap_owner = await ensure_bootstrap_owner(session, user_store)
            await session.commit()

        key = ApiKey(
            user_id=admin_id,
            key_hash="h",
            encrypted_key="e",
            label="deployment bootstrap",
            type=BOOTSTRAP_KEY_TYPE,
        )
        async with session_factory() as session:
            owner_id = await resolve_registration_owner_id(session, user_store, key)

        assert owner_id == bootstrap_owner.id
        assert owner_id != admin_id

    async def test_bootstrap_key_without_a_seeded_owner_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        admin_id = await _make_user(session_factory, role="admin")
        key = ApiKey(
            user_id=admin_id,
            key_hash="h",
            encrypted_key="e",
            label="deployment bootstrap",
            type=BOOTSTRAP_KEY_TYPE,
        )
        async with session_factory() as session:
            with pytest.raises(RuntimeError):
                await resolve_registration_owner_id(session, user_store, key)

    async def test_bootstrap_owner_promoted_to_admin_after_startup_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`ensure_bootstrap_owner` only runs once at startup, so a later
        promotion of the bootstrap owner to admin (e.g. by a gateway admin
        editing the account, or an OIDC identity being linked to it after
        #397) must still be caught here, at registration time."""
        user_store = UserStore()
        admin_id = await _make_user(session_factory, role="admin")
        async with session_factory() as session:
            bootstrap_owner = await ensure_bootstrap_owner(session, user_store)
            await session.commit()

        async with session_factory() as session:
            promoted = await session.get(User, bootstrap_owner.id)
            assert promoted is not None
            promoted.role = "admin"
            await session.commit()

        key = ApiKey(
            user_id=admin_id,
            key_hash="h",
            encrypted_key="e",
            label="deployment bootstrap",
            type=BOOTSTRAP_KEY_TYPE,
        )
        async with session_factory() as session:
            with pytest.raises(RuntimeError, match="admin"):
                await resolve_registration_owner_id(session, user_store, key)

    async def test_role_user_squatter_at_the_bootstrap_address_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Registration-time counterpart of the squatter case above: even
        without ever having run `ensure_bootstrap_owner`, a bootstrap-type
        key must not resolve to an unmarked account at that address."""
        user_store = UserStore()
        admin_id = await _make_user(session_factory, role="admin")
        async with session_factory() as session:
            session.add(User(name="squatter", email=BOOTSTRAP_OWNER_EMAIL, role="user"))
            await session.commit()

        key = ApiKey(
            user_id=admin_id,
            key_hash="h",
            encrypted_key="e",
            label="deployment bootstrap",
            type=BOOTSTRAP_KEY_TYPE,
        )
        async with session_factory() as session:
            with pytest.raises(RuntimeError, match="cannot be proven"):
                await resolve_registration_owner_id(session, user_store, key)
