"""Seeding the deployment-wide agent-registration bootstrap key.

See `bridges/agent/test_registration_bootstrap.py` for what the key resolves
to; this covers the seeding lifecycle itself: fresh install, in-place
rotation, and that a deliberate revocation (deleting the key from the
gateway's API Keys page) survives a restart instead of being silently
recreated.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_LABEL,
    BOOTSTRAP_KEY_TYPE,
    LEGACY_BOOTSTRAP_KEY_LABEL,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import ApiKey, User
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.main import (
    _BOOTSTRAP_SEEDED_FLAG,
    _seed_agent_registration_bootstrap_key,
)

ADMIN_EMAIL = "admin@switch.local"


def _config(token: str) -> SwitchConfig:
    return SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        matrix_server_name="test",
        agent_registration_token=token,
        jwt_secret_key="test-jwt-secret",
        gateway_admin_email=ADMIN_EMAIL,
        gateway_admin_password="unused",
    )


async def _make_admin(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        admin = User(name="Admin", email=ADMIN_EMAIL, role="admin")
        session.add(admin)
        await session.commit()
        return admin.id


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TestSeedAgentRegistrationBootstrapKey:
    async def test_fresh_install_seeds_one_bootstrap_key_owned_by_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            admin = await user_store.get(session, admin_id)

        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("dev-test-token")
        assert bootstrap_keys[0].label == BOOTSTRAP_KEY_LABEL
        assert admin is not None
        assert (admin.metadata_ or {}).get(_BOOTSTRAP_SEEDED_FLAG) is True

    async def test_rerunning_with_the_same_token_is_a_no_op(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )
        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        assert len([k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]) == 1

    async def test_migrates_a_legacy_admin_owned_registration_key_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        async with session_factory() as session:
            legacy = ApiKey(
                user_id=admin_id,
                key_hash=_hash("dev-test-token"),
                encrypted_key="irrelevant",
                label=LEGACY_BOOTSTRAP_KEY_LABEL,
                type="registration",
            )
            session.add(legacy)
            await session.commit()
            legacy_id = legacy.id

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].id == legacy_id
        assert bootstrap_keys[0].label == BOOTSTRAP_KEY_LABEL
        assert not any(k.type == "registration" for k in keys)

    async def test_rotating_the_token_updates_the_existing_key_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, _config("old-token")
        )
        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, _config("new-token")
        )

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("new-token")

    async def test_revoking_the_key_survives_a_restart_with_the_same_token(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Deleting the seeded key (as an operator would from the gateway's
        API Keys page) must be a durable revocation: restarting the server
        with the same, unchanged AGENT_REGISTRATION_TOKEN must not bring it
        back — the old failure this guards against is exactly that."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        await _seed_agent_registration_bootstrap_key(
            session_factory, user_store, api_key_store, config
        )

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        assert not any(k.type == BOOTSTRAP_KEY_TYPE for k in keys)

    async def test_missing_admin_user_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError):
            await _seed_agent_registration_bootstrap_key(
                session_factory, user_store, api_key_store, config
            )
