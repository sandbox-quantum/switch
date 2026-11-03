from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.stores.trust_settings_store import TrustSettingsStore


class TestTrustSettingsStore:
    async def test_absent_row_is_none(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            assert await store.get(session) is None

    async def test_upsert_then_get(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            await session.commit()

            settings = await store.get(session)
            assert settings is not None
            assert settings.endpoint == "https://trust.example"
            assert settings.policy_id == "pol_123"
            assert settings.api_key_encrypted == "enc:k"

    async def test_upsert_is_idempotent_on_the_one_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            await store.upsert(
                session,
                endpoint="https://other.example",
                policy_id="pol_456",
                api_key_encrypted="enc:k2",
                share_agent_instructions=None,
            )
            await session.commit()

            settings = await store.get(session)
            assert settings is not None
            assert settings.endpoint == "https://other.example"
            assert settings.policy_id == "pol_456"
            assert settings.api_key_encrypted == "enc:k2"

    async def test_upsert_can_leave_the_api_key_untouched(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            await store.upsert(
                session,
                endpoint="https://trust2.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            await session.commit()

            settings = await store.get(session)
            assert settings is not None
            assert settings.api_key_encrypted == "enc:k"
            assert settings.endpoint == "https://trust2.example"

    async def test_upsert_with_no_key_given_preserves_the_stored_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`api_key_encrypted=None` means "leave it alone", not "clear it" —
        the merge a caller resolves by passing `None` rather than reading the
        row first, so a concurrent save of just the endpoint can't race one
        that just changed the key."""
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            await store.upsert(
                session,
                endpoint="https://trust2.example",
                policy_id="pol_123",
                api_key_encrypted=None,
                share_agent_instructions=None,
            )
            await session.commit()

            settings = await store.get(session)
            assert settings is not None
            assert settings.api_key_encrypted == "enc:k"
            assert settings.endpoint == "https://trust2.example"

    async def test_sharing_instructions_is_off_until_turned_on_and_kept_when_omitted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            created = await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id=None,
                api_key_encrypted="enc:k",
                share_agent_instructions=None,
            )
            assert created.share_agent_instructions is False

            turned_on = await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id=None,
                api_key_encrypted=None,
                share_agent_instructions=True,
            )
            assert turned_on.share_agent_instructions is True

            # A client from before the setting saves without it.
            kept = await store.upsert(
                session,
                endpoint="https://trust2.example",
                policy_id=None,
                api_key_encrypted=None,
                share_agent_instructions=None,
            )
            assert kept.share_agent_instructions is True

            turned_off = await store.upsert(
                session,
                endpoint="https://trust2.example",
                policy_id=None,
                api_key_encrypted=None,
                share_agent_instructions=False,
            )
            assert turned_off.share_agent_instructions is False

    async def test_clear_drops_the_key_and_keeps_the_sharing_choice(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
                share_agent_instructions=True,
            )
            await session.commit()

            cleared = await store.clear(session)
            await session.commit()

            assert cleared is not None
            assert cleared.api_key_encrypted is None
            assert cleared.policy_id is None
            assert cleared.endpoint == "https://trust.example"
            assert cleared.share_agent_instructions is True
