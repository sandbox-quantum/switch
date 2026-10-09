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
            )
            await store.upsert(
                session,
                endpoint="https://other.example",
                policy_id="pol_456",
                api_key_encrypted="enc:k2",
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
            )
            await store.upsert(
                session,
                endpoint="https://trust2.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
            )
            await session.commit()

            settings = await store.get(session)
            assert settings is not None
            assert settings.api_key_encrypted == "enc:k"
            assert settings.endpoint == "https://trust2.example"

    async def test_clear_removes_the_row(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = TrustSettingsStore()
        async with session_factory() as session:
            await store.upsert(
                session,
                endpoint="https://trust.example",
                policy_id="pol_123",
                api_key_encrypted="enc:k",
            )
            await session.commit()

            await store.clear(session)
            await session.commit()

            assert await store.get(session) is None
