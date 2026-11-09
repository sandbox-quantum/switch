"""An event about a change is sent once the change is committed, never for
one that rolled back.

Against real Postgres, because commit and rollback are what is being tested.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.telemetry import emit_after_commit
from tests.telemetry_records import recording_telemetry

WOKEN = {"trigger": "message"}


async def test_it_is_sent_when_the_transaction_commits(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = recording_telemetry()
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        emit_after_commit(session, service, "cloud_machine_woken", WOKEN)
        assert sink.sent == []
        await session.commit()
    await service.aclose()

    assert sink.events("cloud_machine_woken") == [WOKEN]


async def test_a_rolled_back_change_is_never_sent_not_even_by_a_later_commit(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = recording_telemetry()
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        emit_after_commit(session, service, "cloud_machine_woken", WOKEN)
        await session.rollback()
        await session.execute(text("SELECT 1"))
        await session.commit()
    await service.aclose()

    assert sink.sent == []


async def test_a_savepoint_rolling_back_does_not_cancel_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = recording_telemetry()
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        emit_after_commit(session, service, "cloud_machine_woken", WOKEN)
        nested = await session.begin_nested()
        await nested.rollback()
        await session.commit()
    await service.aclose()

    assert sink.events("cloud_machine_woken") == [WOKEN]


async def test_a_savepoint_committing_does_not_count_when_the_transaction_rolls_back(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = recording_telemetry()
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        emit_after_commit(session, service, "cloud_machine_woken", WOKEN)
        nested = await session.begin_nested()
        await session.execute(text("SELECT 1"))
        await nested.commit()
        await session.rollback()
    await service.aclose()

    assert sink.sent == []


async def test_a_savepoint_committing_inside_a_committed_transaction_sends_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service, sink = recording_telemetry()
    async with session_factory() as session:
        await session.execute(text("SELECT 1"))
        emit_after_commit(session, service, "cloud_machine_woken", WOKEN)
        nested = await session.begin_nested()
        await nested.commit()
        await session.commit()
    await service.aclose()

    assert sink.events("cloud_machine_woken") == [WOKEN]


async def test_nothing_is_wired_where_there_is_no_service(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        emit_after_commit(session, None, "cloud_machine_woken", WOKEN)
        await session.commit()
