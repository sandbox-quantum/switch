"""A request cancelled mid-query must not hand its dead connection to the next.

Starlette cancels a request whose client went away through an anyio cancel
scope, which re-delivers the cancellation at every await. SQLAlchemy reacts to
the first by invalidating the connection, and the second then lands inside
that invalidation's terminate, which unwinds before the pool record forgets
the connection. The record goes back to the pool still holding the closed
asyncpg connection, and whoever checks it out next failed with "connection is
closed" until the engine learned to refuse a closed connection at checkout.
"""

from __future__ import annotations

import asyncio
from typing import Annotated

import anyio
from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.engine import create_engine_from_config, create_session_factory
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import get_current_user
from tests.switch_core.db.test_dead_peer_detection import _config_for
from tests.switch_core.management.harness import add_member, build_harness, cookies_for


async def test_a_cancelled_query_does_not_poison_the_next_checkout(
    postgres_url: str,
) -> None:
    engine = create_engine_from_config(
        _config_for(postgres_url, db_pool_size=1, db_max_overflow=0)
    )
    try:
        with anyio.move_on_after(0.2) as scope:
            async with engine.connect() as conn:
                await conn.execute(text("select pg_sleep(5)"))
        assert scope.cancelled_caught

        async with engine.connect() as conn:
            assert (await conn.execute(text("select 1"))).scalar_one() == 1
    finally:
        await engine.dispose()


async def test_cancelling_one_request_does_not_fail_a_concurrent_one(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    # One pooled connection, so the concurrent request is handed exactly the
    # one the cancelled request was using.
    engine = create_engine_from_config(
        _config_for(postgres_url, db_pool_size=1, db_max_overflow=0)
    )
    try:
        harness = build_harness(create_session_factory(engine))
        sleeping = asyncio.Event()

        @harness.gateway_app.get("/test/slow")
        async def slow(
            _user: Annotated[object, Depends(get_current_user)],
            session: Annotated[AsyncSession, Depends(gw_deps.get_session)],
        ) -> None:
            sleeping.set()
            await session.execute(text("select pg_sleep(5)"))

        @harness.gateway_app.get("/test/fast")
        async def fast(
            _user: Annotated[object, Depends(get_current_user)],
            session: Annotated[AsyncSession, Depends(gw_deps.get_session)],
        ) -> int:
            return int((await session.execute(text("select 1"))).scalar_one())

        ada = await add_member(session_factory, "ada")
        cookies = cookies_for(ada)
        async with harness.client() as client:
            async with anyio.create_task_group() as group:
                slow_scope = anyio.CancelScope()

                async def run_slow() -> None:
                    with slow_scope:
                        await client.get("/gateway/test/slow", cookies=cookies)
                    assert slow_scope.cancelled_caught

                group.start_soon(run_slow)
                await sleeping.wait()
                concurrent = asyncio.ensure_future(
                    client.get("/gateway/test/fast", cookies=cookies)
                )
                await asyncio.sleep(0.1)
                slow_scope.cancel()

            assert (await concurrent).status_code == 200
            after = await client.get("/gateway/test/fast", cookies=cookies)
            assert after.status_code == 200
    finally:
        await engine.dispose()
