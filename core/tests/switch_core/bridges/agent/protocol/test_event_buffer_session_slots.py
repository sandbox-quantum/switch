"""`EventBuffer.one_session` lets at most `session_slots` blocks hold a
connection at once, so the streams' passes cannot take the whole pool from
requests when a pod is saturated."""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID
from tests.db_buffer import db_buffer_on


async def _hold(
    buffer, inside: list[int], most: list[int], release: asyncio.Event
) -> None:
    async with buffer.one_session(TENANT_ZERO_ID) as session:
        await session.execute(text("select 1"))
        inside[0] += 1
        most[0] = max(most[0], inside[0])
        await release.wait()
        inside[0] -= 1


async def test_blocks_over_the_limit_wait_their_turn(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory, session_slots=2)
    inside, most, release = [0], [0], asyncio.Event()
    tasks = [
        asyncio.create_task(_hold(buffer, inside, most, release)) for _ in range(5)
    ]
    for _ in range(50):
        if inside[0] == 2:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)

    assert inside[0] == 2

    release.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
    assert most[0] == 2


async def test_a_block_that_fails_gives_its_slot_back(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory, session_slots=1)
    with pytest.raises(RuntimeError, match="boom"):
        async with buffer.one_session(TENANT_ZERO_ID):
            raise RuntimeError("boom")

    async with asyncio.timeout(2):
        async with buffer.one_session(TENANT_ZERO_ID) as session:
            assert (await session.execute(text("select 1"))).scalar_one() == 1


async def test_a_cancelled_waiter_takes_no_slot(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory, session_slots=1)
    inside, most, release = [0], [0], asyncio.Event()
    holder = asyncio.create_task(_hold(buffer, inside, most, release))
    await asyncio.sleep(0.05)
    waiter = asyncio.create_task(_hold(buffer, inside, most, release))
    await asyncio.sleep(0.05)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    release.set()
    await asyncio.wait_for(holder, timeout=5)
    async with asyncio.timeout(2):
        async with buffer.one_session(TENANT_ZERO_ID):
            pass


async def test_without_a_limit_every_block_goes_in(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory)
    inside, most, release = [0], [0], asyncio.Event()
    tasks = [
        asyncio.create_task(_hold(buffer, inside, most, release)) for _ in range(5)
    ]
    for _ in range(100):
        if inside[0] == 5:
            break
        await asyncio.sleep(0.01)

    assert inside[0] == 5

    release.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)


async def test_a_block_inside_another_raises_rather_than_waiting_on_its_own_slot(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    buffer = db_buffer_on(session_factory, session_slots=1)
    async with buffer.one_session(TENANT_ZERO_ID):
        with pytest.raises(RuntimeError, match="inside another"):
            async with asyncio.timeout(2):
                async with buffer.one_session(TENANT_ZERO_ID):
                    pass
