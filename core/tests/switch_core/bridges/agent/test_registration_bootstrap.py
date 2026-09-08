from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_TYPE,
    BOOTSTRAP_OWNER_EMAIL,
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
    async def test_creates_a_non_admin_user_once(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store = UserStore()
        async with session_factory() as session:
            owner = await ensure_bootstrap_owner(session, user_store)
            await session.commit()
            assert owner.email == BOOTSTRAP_OWNER_EMAIL
            assert owner.role != "admin"

        async with session_factory() as session:
            again = await ensure_bootstrap_owner(session, user_store)
            await session.commit()
            assert again.id == owner.id

    async def test_refuses_an_existing_account_with_the_admin_role(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Nothing reserves this address: a gateway admin can `POST /users`
        with it and an admin role, or an OIDC provider can hand it to any
        identity that asserts it. Adopting that account would silently
        restore the exact escalation this module exists to close."""
        user_store = UserStore()
        async with session_factory() as session:
            session.add(
                User(name="squatter", email=BOOTSTRAP_OWNER_EMAIL, role="admin")
            )
            await session.commit()

        async with session_factory() as session:
            with pytest.raises(RuntimeError, match="admin"):
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
