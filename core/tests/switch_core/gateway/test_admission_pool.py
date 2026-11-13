"""However many requests clients send at once, the process's own work still
finds a connection (`gateway/admission.py`). Real Postgres, a real pool, and a
gateway route that holds its connection until the test lets it go."""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine

from switch_core.db.engine import create_session_factory
from switch_core.gateway import admission
from switch_core.gateway.admission import GatewayAdmission
from switch_core.gateway.auth import create_jwt
from switch_core.keys import Keyring

_KEYRING = Keyring.parse("test:" + secrets.token_hex(32), legacy_secret=None)
POOL = 6
RESERVE = 2


def _session(user_id: str) -> str:
    return create_jwt(
        user_id,
        f"{user_id}@example.com",
        "user",
        _KEYRING,
        None,
        session_version=0,
        auth_time=datetime.now(UTC),
    )


@pytest.fixture
async def engine(postgres_schema: str) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(
        postgres_schema, pool_size=POOL, max_overflow=0, pool_timeout=1
    )
    try:
        yield engine
    finally:
        await engine.dispose()


def _gateway(engine: AsyncEngine, release: asyncio.Event) -> FastAPI:
    factory = create_session_factory(engine)
    app = FastAPI()

    @app.get("/heavy")
    async def heavy() -> dict[str, str]:
        async with factory() as session:
            await session.execute(text("SELECT 1"))
            await release.wait()
        return {}

    return app


async def _flood(
    app: Any, callers: int, each: int
) -> tuple[list[asyncio.Task], list[httpx.AsyncClient]]:
    tasks, clients = [], []
    for n in range(callers):
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={"switch_auth": _session(f"user-{n}")},
            timeout=30,
        )
        clients.append(client)
        tasks += [asyncio.create_task(client.get("/heavy")) for _ in range(each)]
    return tasks, clients


async def _own_work(engine: AsyncEngine) -> None:
    """What renewing a lease needs: one connection, briefly."""
    async with AsyncSession(engine) as session:
        await session.execute(text("SELECT 1"))


async def _held(engine: AsyncEngine, count: int) -> None:
    for _ in range(400):
        if engine.pool.checkedout() >= count:  # type: ignore[attr-defined]
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never {count} connections checked out")


async def test_a_flood_of_requests_leaves_the_reserve_to_the_process(
    engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(admission, "WAIT_S", 10.0)
    release = asyncio.Event()
    app = GatewayAdmission(
        _gateway(engine, release),
        limit=POOL - RESERVE,
        per_caller=2,
        read_timeout="10s",
        keyring=_KEYRING,
    )
    tasks, clients = await _flood(app, callers=10, each=3)
    await _held(engine, POOL - RESERVE)
    await asyncio.sleep(0.1)

    assert engine.pool.checkedout() == POOL - RESERVE  # type: ignore[attr-defined]
    await asyncio.wait_for(_own_work(engine), timeout=0.5)

    release.set()
    answers = await asyncio.gather(*tasks)
    await asyncio.gather(*(c.aclose() for c in clients))
    assert {a.status_code for a in answers} == {200}


async def test_without_it_the_same_flood_takes_every_connection(
    engine: AsyncEngine,
) -> None:
    release = asyncio.Event()
    app = _gateway(engine, release)
    tasks, clients = await _flood(app, callers=10, each=3)
    await _held(engine, POOL)

    with pytest.raises(Exception, match="QueuePool limit"):
        await _own_work(engine)

    release.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    await asyncio.gather(*(c.aclose() for c in clients))
