"""Per-tenant usage counters, against a real database.

The upsert, the hour bucket and the check constraints are the behaviour, so
none of this is mocked.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    Tenant,
    TenantUsage,
    UsageMetric,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.usage_store import UsageStore

OTHER_TENANT = "11111111-1111-1111-1111-111111111111"


async def _client(session: AsyncSession, name: str) -> str:
    client = Client(matrix_user_id=f"@{name}:test", display_name=name, type="agent")
    session.add(client)
    await session.flush()
    return client.id


async def _record(
    session: AsyncSession,
    client_id: str,
    *,
    metric: UsageMetric = UsageMetric.MESSAGES,
    model: str = "",
    amount: int = 1,
    tenant_id: str = TENANT_ZERO_ID,
) -> None:
    await UsageStore().record(
        session,
        tenant_id=tenant_id,
        metric=metric,
        client_id=client_id,
        model=model,
        amount=amount,
    )


def _hour(offset: int) -> datetime:
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    return now + timedelta(hours=offset)


class TestRecording:
    async def test_counts_in_the_same_hour_add_up(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id = await _client(session, "counted")
            await _record(session, client_id)
            await _record(session, client_id, amount=4)
            await session.commit()

        async with session_factory() as session:
            rows = (await session.scalars(select(TenantUsage))).all()

        assert len(rows) == 1
        assert rows[0].amount == 5
        assert rows[0].bucket_start == _hour(0)

    async def test_metrics_and_models_are_counted_apart(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id = await _client(session, "several")
            await _record(session, client_id)
            await _record(session, client_id, metric=UsageMetric.TURNS)
            await _record(
                session, client_id, metric=UsageMetric.INPUT_TOKENS, model="a"
            )
            await _record(
                session, client_id, metric=UsageMetric.INPUT_TOKENS, model="b"
            )
            await session.commit()

        async with session_factory() as session:
            count = await session.scalar(select(func.count()).select_from(TenantUsage))

        assert count == 4

    async def test_a_count_that_is_not_positive_is_refused(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # A zero or negative amount would let a caller spend usage back, so it
        # is an error at the door rather than an adjustment.
        async with session_factory() as session:
            client_id = await _client(session, "refused")
            with pytest.raises(ValueError, match="positive"):
                await _record(session, client_id, amount=0)

    async def test_the_database_refuses_an_unknown_metric(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(
                TenantUsage(
                    metric="vibes",
                    bucket_start=_hour(0),
                    client_id="c",
                    model="",
                    amount=1,
                )
            )
            with pytest.raises(IntegrityError, match="ck_tenant_usage_metric"):
                await session.flush()


class TestTotals:
    async def test_totals_cover_the_hours_in_the_window(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            client_id = await _client(session, "windowed")
            for offset, amount in ((-3, 100), (-2, 10), (-1, 1), (0, 1000)):
                session.add(
                    TenantUsage(
                        metric="messages",
                        bucket_start=_hour(offset),
                        client_id=client_id,
                        model="",
                        amount=amount,
                    )
                )
            await session.commit()

        async with session_factory() as session:
            # `since` mid-hour still takes that whole hour; `until` excludes
            # the bucket that starts on it.
            totals = await UsageStore().totals(
                session,
                tenant_id=TENANT_ZERO_ID,
                since=_hour(-2) + timedelta(minutes=30),
                until=_hour(0),
            )

        assert [(t.metric, t.client_name, t.amount) for t in totals] == [
            ("messages", "windowed", 11)
        ]

    async def test_usage_outlives_the_client_it_names(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # What a deleted client spent is still the tenant's spend.
        async with session_factory() as session:
            await _record(session, "gone-client")
            await session.commit()

        async with session_factory() as session:
            totals = await UsageStore().totals(
                session, tenant_id=TENANT_ZERO_ID, since=_hour(-1), until=_hour(1)
            )

        assert len(totals) == 1
        assert totals[0].client_id == "gone-client"
        assert totals[0].client_name is None
        assert totals[0].amount == 1

    async def test_another_tenants_usage_is_not_counted(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The owner connection ignores the policy, so this is the explicit
        # tenant filter doing the work — the one a fan-out relies on.
        async with session_factory() as session:
            session.add(Tenant(id=OTHER_TENANT, slug="other", name="Other"))
            await session.commit()
        async with tenant_session(session_factory, OTHER_TENANT) as session:
            await _record(session, "theirs", amount=50, tenant_id=OTHER_TENANT)
            await session.commit()
        async with session_factory() as session:
            await _record(session, "ours", amount=2)
            await session.commit()

        async with session_factory() as session:
            totals = await UsageStore().totals(
                session, tenant_id=TENANT_ZERO_ID, since=_hour(-1), until=_hour(1)
            )

        assert [(t.client_id, t.amount) for t in totals] == [("ours", 2)]
