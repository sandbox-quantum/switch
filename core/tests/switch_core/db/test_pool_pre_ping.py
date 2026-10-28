"""What turning the pool's pre-ping off costs (`db_pool_pre_ping`).

A pooled connection the server closed while it sat in the pool is the case
the pre-ping exists for: a database restart closes every connection the pool
holds. With the pre-ping off, the first query on one of them fails, and
SQLAlchemy then treats every connection the pool held at that moment as
stale and replaces it on its next checkout. So a restart costs one failed
query, not one per pooled connection, which is the trade the default makes.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from switch_core.config import SwitchConfig
from switch_core.db.engine import create_engine_from_config, create_unpooled_engine
from tests.switch_core.db.test_dead_peer_detection import _config_for

POOLED = 3


async def _pid(conn: AsyncConnection) -> int:
    return int((await conn.execute(text("select pg_backend_pid()"))).scalar_one())


async def _fill_and_close_pool(
    postgres_url: str, *, pre_ping: bool
) -> tuple[AsyncEngine, set[int]]:
    """An engine whose pool holds `POOLED` connections, every one of which the
    server has since closed, as a restart does. Returns the engine and the
    closed connections' backend pids."""
    engine = create_engine_from_config(
        _config_for(
            postgres_url,
            db_pool_size=POOLED,
            db_max_overflow=0,
            db_pool_pre_ping=pre_ping,
        )
    )
    held = [await engine.connect() for _ in range(POOLED)]
    pids = {await _pid(conn) for conn in held}
    for conn in held:
        await conn.close()
    closer = create_unpooled_engine(_config_for(postgres_url))
    try:
        async with closer.connect() as conn:
            for pid in pids:
                await conn.execute(
                    text("select pg_terminate_backend(:pid)"), {"pid": pid}
                )
            # Termination is a signal: wait until the backends have exited, or
            # one could still answer a ping and then die under the next query.
            for _ in range(100):
                left = await conn.scalar(
                    text(
                        "select count(*) from pg_stat_activity where pid = any(:pids)"
                    ),
                    {"pids": list(pids)},
                )
                if not left:
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("the closed backends did not exit")
    finally:
        await closer.dispose()
    return engine, pids


def test_the_pre_ping_is_off_by_default() -> None:
    assert SwitchConfig.model_fields["db_pool_pre_ping"].default is False


async def test_without_the_pre_ping_a_restart_costs_one_failed_query(
    postgres_url: str,
) -> None:
    engine, closed = await _fill_and_close_pool(postgres_url, pre_ping=False)
    try:
        with pytest.raises(DBAPIError) as failed:
            async with engine.connect() as conn:
                await _pid(conn)
        assert failed.value.connection_invalidated

        # Every connection after it is a new one, though two more of the
        # closed ones were still in the pool when the first query failed.
        for _ in range(POOLED):
            async with engine.connect() as conn:
                assert await _pid(conn) not in closed
    finally:
        await engine.dispose()


async def test_with_the_pre_ping_no_query_fails(postgres_url: str) -> None:
    engine, closed = await _fill_and_close_pool(postgres_url, pre_ping=True)
    try:
        for _ in range(POOLED):
            async with engine.connect() as conn:
                assert await _pid(conn) not in closed
    finally:
        await engine.dispose()
