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
    BOOTSTRAP_LAST_SEEDED_HASH_META_KEY,
    BOOTSTRAP_OWNER_EMAIL,
    BOOTSTRAP_OWNER_MARKER_META_KEY,
    BOOTSTRAP_OWNER_NAME,
    BOOTSTRAP_REVOKED_HASHES_META_KEY,
    LEGACY_BOOTSTRAP_KEY_LABEL,
    RETIRED_KEY_TYPE,
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
    session_factory: async_sessionmaker[AsyncSession],
    *,
    email: str,
    role: str,
    metadata: dict | None = None,
) -> str:
    async with session_factory() as session:
        user = User(name=role, email=email, role=role, metadata_=metadata)
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

    async def test_a_legacy_key_rotated_before_the_upgrade_is_retired_not_left_live(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """An operator who rotates AGENT_REGISTRATION_TOKEN at or before the
        upgrade (ordinary practice) leaves the legacy row's hash stale, so a
        hash-only lookup for the *current* token would never find it to
        migrate. Left alone, that row keeps authenticating as
        `type="registration"`, owned by the admin — exactly the escalation
        this PR exists to close, and permanently, since a bootstrap key
        exists after this run and later runs never look for it again.

        Retired, not deleted: the row must stop authenticating but stay
        visible (and its old value permanently revoked, so restoring an old
        .env or values file can't bring it back either)."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        async with session_factory() as session:
            legacy = ApiKey(
                user_id=admin_id,
                key_hash=_hash("old-token"),
                encrypted_key="irrelevant",
                label=LEGACY_BOOTSTRAP_KEY_LABEL,
                type="registration",
            )
            session.add(legacy)
            await session.commit()
            legacy_id = legacy.id

        await _seed(session_factory, user_store, api_key_store, _config("new-token"))

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        by_id = {k.id: k for k in keys}
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("new-token")
        # Still visible, no longer live: retired, not gone.
        assert legacy_id in by_id
        assert by_id[legacy_id].type == RETIRED_KEY_TYPE
        assert by_id[legacy_id].type not in ("registration", BOOTSTRAP_KEY_TYPE)

        # Restoring the old .env (or a stale values file) must not resurrect
        # it: its hash is permanently revoked, not just retyped away.
        await _seed(session_factory, user_store, api_key_store, _config("old-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("new-token")

    async def test_deleting_the_retired_row_then_restoring_the_old_token_stays_blocked(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The case with no constraint to fall back on. Above, restoring the
        old token while the retired row is still present is blocked twice
        over: the revoked-hashes check, and (if that ever failed) the unique
        constraint on key_hash, since the retired row still holds the old
        value. Once an operator deletes that retired row from the API Keys
        page — exactly what the warning invites them to do — that row is
        gone and the constraint can no longer save a bug here. Only the
        revoked-hashes list, recorded at retirement time, stands between the
        old token and reinstating admin-authority registration."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        async with session_factory() as session:
            legacy = ApiKey(
                user_id=admin_id,
                key_hash=_hash("old-token"),
                encrypted_key="irrelevant",
                label=LEGACY_BOOTSTRAP_KEY_LABEL,
                type="registration",
            )
            session.add(legacy)
            await session.commit()

        await _seed(session_factory, user_store, api_key_store, _config("new-token"))

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (retired,) = [k for k in keys if k.type == RETIRED_KEY_TYPE]
            await api_key_store.delete(session, retired.id)
            await session.commit()

        # No row anywhere holds H(old-token) now. If this were still guarded
        # only by the unique constraint, this call would succeed and rotate
        # the active key back onto the revoked value.
        await _seed(session_factory, user_store, api_key_store, _config("old-token"))

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("new-token")
        assert not any(k.key_hash == _hash("old-token") for k in keys)

    async def test_a_hash_mismatched_legacy_labeled_key_is_retired_and_warned_about(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The label alone cannot tell a stale, rotated-out bootstrap key
        (finding 1: dangerous — admin-owned, still registers agents with
        admin authority) apart from a personal key an admin happened to
        label identically (finding 5's contrived scenario). Nothing in the
        schema distinguishes them once the hash no longer matches, so this
        favours closing the real, silent escalation: retire the row (so it
        can no longer register anything, but stays visible on the API Keys
        page instead of vanishing) and name it loudly in a warning, so the
        rare coincidental case is at least visible and recoverable rather
        than a permanent, silent hole."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)
        config = _config("dev-test-token")

        async with session_factory() as session:
            stale = ApiKey(
                user_id=admin_id,
                key_hash=_hash("some-other-value"),
                encrypted_key="irrelevant",
                label=LEGACY_BOOTSTRAP_KEY_LABEL,
                type="registration",
            )
            session.add(stale)
            await session.commit()
            stale_id = stale.id

        with caplog.at_level("WARNING", logger="switch_core.main"):
            await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        by_id = {k.id: k for k in keys}
        assert stale_id in by_id, "the retired row must still be visible"
        assert by_id[stale_id].type == RETIRED_KEY_TYPE
        assert "retired" in by_id[stale_id].label.lower()
        assert len([k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]) == 1
        warnings = [r.message for r in caplog.records if r.levelname == "WARNING"]
        assert any(stale_id in w for w in warnings)

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

    async def test_rotating_back_to_a_revoked_value_does_not_reinstate_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Revoke X, rotate to Y and restart, rotate back to X and restart:
        the deployment must keep serving Y (or nothing), never X again — a
        revoked value is refused forever, not just until the next rotation."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        admin_id = await _make_admin(session_factory)

        await _seed(session_factory, user_store, api_key_store, _config("x-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
            (bootstrap_key,) = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
            await api_key_store.delete(session, bootstrap_key.id)
            await session.commit()

        # Rotate forward to Y: re-enabled at the new value.
        await _seed(session_factory, user_store, api_key_store, _config("y-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("y-token")

        # Rotate back to X: must not reinstate the revoked value. Y stays active.
        await _seed(session_factory, user_store, api_key_store, _config("x-token"))
        async with session_factory() as session:
            keys = await api_key_store.get_by_user(session, admin_id)
        bootstrap_keys = [k for k in keys if k.type == BOOTSTRAP_KEY_TYPE]
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("y-token")
        assert not any(k.key_hash == _hash("x-token") for k in keys)

    async def test_missing_admin_user_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        user_store, api_key_store = UserStore(), ApiKeyStore()
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError):
            await _seed(session_factory, user_store, api_key_store, config)

    async def test_malformed_revoked_hashes_fails_loud(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A hand-edited, non-list value must not be silently coerced (`list("a
        string")` iterates its characters) into "nothing is revoked"."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        async with session_factory() as session:
            session.add(
                User(
                    name=BOOTSTRAP_OWNER_NAME,
                    email=BOOTSTRAP_OWNER_EMAIL,
                    role="user",
                    metadata_={
                        BOOTSTRAP_OWNER_MARKER_META_KEY: True,
                        BOOTSTRAP_REVOKED_HASHES_META_KEY: "not-a-list",
                    },
                )
            )
            await session.commit()
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError, match="not a list"):
            await _seed(session_factory, user_store, api_key_store, config)

    async def test_promoted_bootstrap_owner_blocks_seeding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The role check exercised on its own: an otherwise-genuine account
        (carries the marker) that was given the admin role directly — e.g. a
        gateway admin editing it — must still block seeding. Marked so this
        hits the role check rather than the separately-tested missing-marker
        one."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        await _make_user(
            session_factory,
            email=BOOTSTRAP_OWNER_EMAIL,
            role="admin",
            metadata={BOOTSTRAP_OWNER_MARKER_META_KEY: True},
        )
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError, match="must never be an admin"):
            await _seed(session_factory, user_store, api_key_store, config)

    async def test_upgrading_past_the_marker_commit_does_not_brick_seeding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A bootstrap owner created by an earlier commit of this same
        feature (before the marker existed) has no marker but does carry the
        last-seeded-hash key, which only this module's own seeding ever
        writes. Seeding must heal it in place rather than refuse to start."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        await _make_user(
            session_factory,
            email=BOOTSTRAP_OWNER_EMAIL,
            role="user",
            metadata={BOOTSTRAP_LAST_SEEDED_HASH_META_KEY: "old-hash"},
        )
        config = _config("dev-test-token")

        await _seed(session_factory, user_store, api_key_store, config)

        async with session_factory() as session:
            owner = await user_store.get_by_email(session, BOOTSTRAP_OWNER_EMAIL)
        assert owner is not None
        assert (owner.metadata_ or {}).get(BOOTSTRAP_OWNER_MARKER_META_KEY) is True

    async def test_role_user_squatter_at_bootstrap_address_blocks_seeding(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The realistic squatter: an identity claimed the bootstrap owner's
        address (e.g. an OIDC login, which always provisions `role="user"`)
        before agent-registration bootstrap ever ran. A role check alone
        would silently adopt this account; only the creation marker this
        module stamps on its own account catches it."""
        user_store, api_key_store = UserStore(), ApiKeyStore()
        await _make_admin(session_factory)
        await _make_user(session_factory, email=BOOTSTRAP_OWNER_EMAIL, role="user")
        config = _config("dev-test-token")

        with pytest.raises(RuntimeError, match="cannot be proven"):
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
            bootstrap_keys = await api_key_store.get_by_type(
                session, BOOTSTRAP_KEY_TYPE
            )
        assert len(bootstrap_keys) == 1
        assert bootstrap_keys[0].key_hash == _hash("dev-test-token")

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
