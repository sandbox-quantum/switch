"""Seeding the deployment-wide agent-registration bootstrap key.

See `bridges/agent/test_registration_bootstrap.py` for what the key resolves
to; this covers the seeding lifecycle itself: fresh install, in-place
rotation, legacy migration, and that a deliberate revocation (deleting the
key from the gateway's API Keys page) survives a restart instead of being
silently recreated — including when the admin email changes underneath it.
"""

from __future__ import annotations

import hashlib

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.registration_bootstrap import (
    BOOTSTRAP_KEY_LABEL,
    BOOTSTRAP_KEY_TYPE,
    BOOTSTRAP_OWNER_EMAIL,
    LEGACY_BOOTSTRAP_KEY_LABEL,
)
from switch_core.config import SwitchConfig
from switch_core.db.models import Agent, ApiKey, Client, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.db.stores.user_store import UserStore
from switch_core.main import _seed_agent_registration_bootstrap_key

ADMIN_EMAIL = "admin@switch.local"


def _config(token: str, *, admin_email: str = ADMIN_EMAIL) -> SwitchConfig:
    return SwitchConfig(
        db_host="unused",
        db_port="5432",
        db_user="unused",
        db_password="unused",
        db_name="unused",
        matrix_server_name="test",
        agent_registration_token=token,
        jwt_secret_key="test-jwt-secret",
        gateway_admin_email=admin_email,
        gateway_admin_password="unused",
    )


async def _make_user(
    session_factory: async_sessionmaker[AsyncSession], *, email: str, role: str
) -> str:
    async with session_factory() as session:
        user = User(name=role, email=email, role=role)
        session.add(user)
        await session.commit()
        return user.id


async def _make_admin(session_factory: async_sessionmaker[AsyncSession]) -> str:
    return await _make_user(session_factory, email=ADMIN_EMAIL, role="admin")


async def _make_agent_owned_by(
    session_factory: async_sessionmaker[AsyncSession], *, owner_id: str, name: str
) -> None:
    async with session_factory() as session:
        client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
        session.add(client)
        await session.flush()
        key = ApiKey(
            user_id=owner_id,
            key_hash=_hash(f"agent-key-{name}"),
            encrypted_key="irrelevant",
            label=name,
            type="agent",
        )
        session.add(key)
        await session.flush()
        session.add(
            Agent(
                name=name,
                description="d",
                agent_type="session_addressable",
                connector_type="claude_code",
                integration_profile={},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=owner_id,
            )
        )
        await session.commit()


async def _seed(
    session_factory: async_sessionmaker[AsyncSession],
    user_store: UserStore,
    api_key_store: ApiKeyStore,
    config: SwitchConfig,
) -> None:
    await _seed_agent_registration_bootstrap_key(
        session_factory, user_store, api_key_store, AgentStore(), config
    )


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TestSeedAgentRegistrationBootstrapKey:
    async def test_fresh_install_seeds_one_bootstrap_key_owned_by_admin(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)

        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("dev-test-token")
        assert bootstrap_keys[0].label == BOOTSTRAP_KEY_LABEL

    async def test_rerunning_with_the_same_token_is_a_no_op(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        await _seed(session_factory, user_store, api_key_store, config)
        await _seed(session_factory, user_store, api_key_store, config)

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

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].id == legacy_id
        assert bootstrap_keys[0].label == BOOTSTRAP_KEY_LABEL
        assert not any(k.type == "registration" for k in keys)

    async def test_a_personal_key_sharing_the_legacy_label_but_not_the_hash_is_untouched(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A label is free text an admin could reuse by coincidence; only a
        matching hash proves a row really is the historical bootstrap key."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        async with session_factory() as session:
            personal = ApiKey(
                user_id=admin_id,
                key_hash=_hash("some-unrelated-personal-secret"),
                encrypted_key="irrelevant",
                label=LEGACY_BOOTSTRAP_KEY_LABEL,
                type="registration",
            )
            session.add(personal)
            await session.commit()
            personal_id = personal.id

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        by_id = {k.id: k for k in keys}
        assert by_id[personal_id].type == "registration"
        assert by_id[personal_id].key_hash == _hash("some-unrelated-personal-secret")
        assert len([k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]) == 1

    async def test_revoking_a_migrated_legacy_key_survives_a_restart(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The durable marker must be recorded on the very call that migrates
        a legacy key, not only on a later, unrelated call — an operator can
        revoke (delete) the freshly migrated key immediately, with no
        intervening restart to have backfilled it."""
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

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        assert not any(k.type == BOOTSTRAP_KEY_TYPE for k in keys)

    async def test_rotating_the_token_updates_the_existing_key_in_place(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        await _seed(session_factory, user_store, api_key_store, _config("old-token"))
        await _seed(session_factory, user_store, api_key_store, _config("new-token"))

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

        await _seed(session_factory, user_store, api_key_store, config)
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        assert not any(k.type == BOOTSTRAP_KEY_TYPE for k in keys)

    async def test_rotating_to_a_new_value_after_revocation_re_enables_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A revoked key stays revoked only for the value it was revoked at.
        An operator with no database access can re-enable deployment-wide
        bootstrap registration by rotating to a new secret."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        await _seed(session_factory, user_store, api_key_store, _config("old-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        # Same value: stays revoked.
        await _seed(session_factory, user_store, api_key_store, _config("old-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        assert not any(k.type == BOOTSTRAP_KEY_TYPE for k in keys)

        # New value: re-enabled.
        await _seed(session_factory, user_store, api_key_store, _config("new-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("new-token")

    async def test_missing_admin_user_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError):
            await _seed(session_factory, user_store, api_key_store, config)

    async def test_bootstrap_owner_promoted_to_admin_blocks_seeding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Adversarial: something (a gateway admin via POST /users, or an
        OIDC identity provider on an upgrading deployment) has already
        claimed the bootstrap owner's reserved address with the admin role.
        Seeding must refuse rather than adopt it — that account would confer
        admin authority on every agent registered through the shared token,
        exactly the escalation this fix closes."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        await _make_user(session_factory, email=BOOTSTRAP_OWNER_EMAIL, role="admin")
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError, match="admin"):
            await _seed(session_factory, user_store, api_key_store, config)

    async def test_admin_owned_agents_are_logged_as_a_warning(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        await _make_agent_owned_by(
            session_factory, owner_id=admin_id, name="admin-owned-agent"
        )
        config = _config("dev-test-token")

        with caplog.at_level("WARNING", logger="switch_core.main"):
            await _seed(session_factory, user_store, api_key_store, config)

        warnings = [r.message for r in caplog.records if r.levelname == "WARNING"]
        assert any("admin-owned-agent" in w for w in warnings)

    async def test_changing_the_admin_email_does_not_crash_or_duplicate_the_key(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The seed check must not be scoped to whichever user the currently
        configured admin email resolves to: an admin-email change must not
        cause a duplicate insert of a key that already exists (and collides
        on the unique key_hash) under the previous admin."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        config = _config("dev-test-token")
        await _seed(session_factory, user_store, api_key_store, config)

        new_admin_email = "new-admin@switch.local"
        await _make_user(session_factory, email=new_admin_email, role="admin")
        new_config = _config("dev-test-token", admin_email=new_admin_email)

        # Must not raise (would previously fail the unique constraint on
        # api_keys.key_hash by trying to insert a second row for the same
        # token under the new admin).
        await _seed(session_factory, user_store, api_key_store, new_config)

        async with session_factory() as session:
            all_keys_by_hash = await api_key_store.get_by_hash(
                session, _hash("dev-test-token")
            )
        assert all_keys_by_hash is not None

    async def test_changing_the_admin_email_after_revocation_does_not_resurrect_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")
        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        new_admin_email = "new-admin@switch.local"
        await _make_user(session_factory, email=new_admin_email, role="admin")
        new_config = _config("dev-test-token", admin_email=new_admin_email)
        await _seed(session_factory, user_store, api_key_store, new_config)

        async with session_factory() as session:
            found = await api_key_store.get_by_hash(session, _hash("dev-test-token"))
        assert found is None
