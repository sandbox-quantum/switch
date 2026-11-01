"""The controller-token cache, end to end: what it saves, and what it must not.

Against Postgres, through the real bearer middleware and the real management
authenticator. Round trips are counted at the cursor, so "avoids the
database" means no statement reached Postgres.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import delete, event, func, update
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool

from switch_core.bridges.agent import held_rows
from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.auth_rows_notify_ddl import (
    AGENT_CHANGED_SIGNAL,
    CONTROLLER_AUTH_CHANGED_SIGNAL,
)
from switch_core.db.models import TENANT_ZERO_ID, Agent, AgentController
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
from switch_core.signals import SIGNAL_CHANNEL
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
    place_agent,
    provider,
    report_status,
)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


class Reads:
    """The SELECTs that reached Postgres, by the table they read."""

    def __init__(self) -> None:
        self.statements: list[str] = []

    def of(self, table: str) -> int:
        return sum(
            1
            for statement in self.statements
            if statement.lstrip().upper().startswith("SELECT")
            and f"FROM {table}" in statement
        )


@contextmanager
def counting(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Reads]:
    engine = session_factory.kw["bind"]
    assert isinstance(engine, AsyncEngine)
    reads = Reads()

    def record(
        conn: Any, cursor: Any, statement: str, *args: Any, **kwargs: Any
    ) -> None:
        reads.statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        yield reads
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)


def middleware(harness: Harness) -> BearerAuthMiddleware:
    async def _app(scope: Any, receive: Any, send: Any) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    return BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=harness.cache,
        session_factory=harness.session_factory,
        controller_auth=harness.management.authenticator,
    )


async def act_as(
    mw: BearerAuthMiddleware, controller: EnrolledController, agent_id: str
) -> tuple[int, str | None]:
    """A request made by `controller` as `agent_id`: its status and error code."""

    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    headers = [(b"authorization", f"Bearer {controller.access_token}".encode())]
    await mw(
        {"type": "http", "path": f"/agents/{agent_id}/ops", "headers": headers},
        receive,
        send,
    )
    body = b"".join(m.get("body", b"") for m in sent[1:])
    code = json.loads(body)["error"]["code"] if body else None
    return sent[0]["status"], code


async def placed(harness: Harness) -> tuple[EnrolledController, str]:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
    return controller, agent_id


async def test_a_cache_hit_reads_neither_the_controller_nor_the_agent(
    harness: Harness,
) -> None:
    controller, agent_id = await placed(harness)
    mw = middleware(harness)
    # Placing the agent took the controller's own routes, which cached it.
    harness.controller_auth_cache.clear()

    with counting(harness.session_factory) as first:
        assert await act_as(mw, controller, agent_id) == (200, None)
    with counting(harness.session_factory) as second:
        assert await act_as(mw, controller, agent_id) == (200, None)

    assert first.of("agent_controllers") == 1
    assert first.of("agents") == 1
    assert second.statements == []


async def test_the_controller_routes_authenticate_from_the_cache_too(
    harness: Harness,
) -> None:
    controller, _ = await placed(harness)
    path = f"/v1/management/controllers/{controller.controller_id}/assignment"

    async def assignment_reads() -> int:
        with counting(harness.session_factory) as reads:
            async with harness.client() as client:
                response = await client.get(path, headers=controller.headers)
        assert response.status_code == 200, response.text
        return reads.of("agent_controllers")

    harness.controller_auth_cache.clear()
    cold = await assignment_reads()
    warm = await assignment_reads()

    # The handler reads the controller for its own reasons; authenticating
    # it is the one read the cache saves.
    assert cold == warm + 1


async def test_a_revoke_is_effective_immediately(harness: Harness) -> None:
    controller, agent_id = await placed(harness)
    mw = middleware(harness)
    assert await act_as(mw, controller, agent_id) == (200, None)
    assert (
        harness.controller_auth_cache.controller(
            TENANT_ZERO_ID, controller.controller_id
        )
        is not None
    )

    async with harness.client() as client:
        revoked = await client.delete(
            f"/gateway/management/controllers/{controller.controller_id}",
            cookies=cookies_for(controller.owner),
        )
    assert revoked.status_code == 200, revoked.text

    assert (
        harness.controller_auth_cache.controller(
            TENANT_ZERO_ID, controller.controller_id
        )
        is None
    )
    assert await act_as(mw, controller, agent_id) == (401, "controller_revoked")
    async with harness.client() as client:
        refused = await client.get(
            f"/v1/management/controllers/{controller.controller_id}/assignment",
            headers=controller.headers,
        )
    assert (refused.status_code, refused.json()["error"]["code"]) == (
        401,
        "controller_revoked",
    )


async def test_an_unbind_is_effective_immediately(harness: Harness) -> None:
    controller, agent_id = await placed(harness)
    mw = middleware(harness)
    assert await act_as(mw, controller, agent_id) == (200, None)
    assert harness.controller_auth_cache.agent(TENANT_ZERO_ID, agent_id) is not None

    async with harness.client() as client:
        unmanaged = await client.delete(
            f"/gateway/management/agents/{agent_id}",
            cookies=cookies_for(controller.owner),
        )
    assert unmanaged.status_code == 200, unmanaged.text

    assert harness.controller_auth_cache.agent(TENANT_ZERO_ID, agent_id) is None
    assert await act_as(mw, controller, agent_id) == (403, "not_assigned")


async def test_a_move_is_effective_immediately(harness: Harness) -> None:
    controller, agent_id = await placed(harness)
    mw = middleware(harness)
    assert await act_as(mw, controller, agent_id) == (200, None)

    async with harness.client() as client:
        other = await enroll_console(harness, client, controller.owner, "other")
        await report_status(client, other, 1, providers=[provider("claude")])
        moved = await client.patch(
            f"/gateway/management/agents/{agent_id}",
            json={"controller_id": other.controller_id},
            cookies=cookies_for(controller.owner),
        )
    assert moved.status_code == 200, moved.text

    assert harness.controller_auth_cache.agent(TENANT_ZERO_ID, agent_id) is None
    assert await act_as(mw, controller, agent_id) == (403, "not_assigned")
    assert await act_as(mw, other, agent_id) == (200, None)


async def test_deleting_the_agent_drops_it_at_once(harness: Harness) -> None:
    controller, agent_id = await placed(harness)
    mw = middleware(harness)
    assert await act_as(mw, controller, agent_id) == (200, None)

    await harness.protocol.delete_agent(agent_id=agent_id)

    assert harness.controller_auth_cache.agent(TENANT_ZERO_ID, agent_id) is None
    assert await act_as(mw, controller, agent_id) == (403, "not_assigned")


async def test_a_ttl_of_zero_reads_the_database_every_time(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    harness = build_harness(session_factory, controller_auth_ttl_seconds=0)
    controller, agent_id = await placed(harness)
    mw = middleware(harness)

    with counting(harness.session_factory) as reads:
        for _ in range(3):
            assert await act_as(mw, controller, agent_id) == (200, None)

    assert reads.of("agent_controllers") == 3
    assert reads.of("agents") == 3
    assert not harness.controller_auth_cache.enabled


async def test_a_controller_s_agents_are_read_together(harness: Harness) -> None:
    """A miss reads every agent bound to the controller, so a request for
    another of them reads none."""
    controller, first = await placed(harness)
    async with harness.client() as client:
        second = await place_agent(client, controller, name="writer")
    mw = middleware(harness)
    harness.controller_auth_cache.clear()

    with counting(harness.session_factory) as reads:
        assert await act_as(mw, controller, first) == (200, None)
        assert await act_as(mw, controller, second) == (200, None)

    assert reads.of("agents") == 1


# ── While the signal bus listens ──────────────────────────────────────────────


@pytest.fixture
async def listening(
    postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
) -> AsyncIterator[Harness]:
    harness = build_harness(
        session_factory,
        signal_engine=lambda: create_async_engine(postgres_url, poolclass=NullPool),
    )
    await harness.management.lease.renew()
    await harness.bus.start()
    await asyncio.wait_for(harness.bus.connected.wait(), 10)
    try:
        yield harness
    finally:
        await harness.bus.stop()


async def _until(condition: Callable[[], bool]) -> None:
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("never happened")


async def test_while_the_bus_listens_a_hit_outlives_the_ttl(
    listening: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    controller, agent_id = await placed(listening)
    mw = middleware(listening)
    assert await act_as(mw, controller, agent_id) == (200, None)
    an_hour_on = time.monotonic() + 3600
    monkeypatch.setattr(
        held_rows, "time", SimpleNamespace(monotonic=lambda: an_hour_on)
    )

    with counting(listening.session_factory) as reads:
        assert await act_as(mw, controller, agent_id) == (200, None)

    assert reads.of("agent_controllers") == 0
    assert reads.of("agents") == 0


async def test_an_agent_changed_in_the_database_is_dropped(listening: Harness) -> None:
    controller, agent_id = await placed(listening)
    mw = middleware(listening)
    assert await act_as(mw, controller, agent_id) == (200, None)
    cache = listening.controller_auth_cache
    assert cache.agent(TENANT_ZERO_ID, agent_id) is not None

    async with tenant_session(listening.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(Agent).where(Agent.id == agent_id).values(description="changed")
        )
        await session.commit()

    await _until(lambda: cache.agent(TENANT_ZERO_ID, agent_id) is None)


async def test_a_controller_revoked_where_nothing_announces_it_is_refused(
    listening: Harness,
) -> None:
    """Revoked by a path that tells no process, as an operator in psql would:
    the trigger tells every one."""
    controller, agent_id = await placed(listening)
    mw = middleware(listening)
    assert await act_as(mw, controller, agent_id) == (200, None)
    cache = listening.controller_auth_cache

    async with tenant_session(listening.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller.controller_id)
            .values(revoked_at=func.now(), api_key_id=None)
        )
        await session.commit()

    await _until(
        lambda: cache.controller(TENANT_ZERO_ID, controller.controller_id) is None
    )
    assert await act_as(mw, controller, agent_id) == (401, "controller_revoked")


# ── The triggers ──────────────────────────────────────────────────────────────

_SENTINEL = "test.sentinel"


@asynccontextmanager
async def heard(postgres_url: str) -> AsyncIterator[list[dict[str, Any]]]:
    """The signals sent while the block runs. A sentinel is sent after the
    block, and signals arrive in commit order, so once it is heard every
    signal the block's commits sent has been too."""
    engine = create_async_engine(postgres_url, poolclass=NullPool)
    signals: list[dict[str, Any]] = []
    done = asyncio.Event()

    def on_notify(_conn: Any, _pid: int, _channel: str, payload: str) -> None:
        signal = json.loads(payload)
        if signal.get("kind") == _SENTINEL:
            done.set()
        else:
            signals.append(signal)

    try:
        async with engine.connect() as connection:
            raw = await connection.get_raw_connection()
            driver = raw.driver_connection
            assert driver is not None
            await driver.add_listener(SIGNAL_CHANNEL, on_notify)
            yield signals
            await driver.execute(
                f"NOTIFY {SIGNAL_CHANNEL}, '{json.dumps({'kind': _SENTINEL})}'"
            )
            await asyncio.wait_for(done.wait(), 10)
    finally:
        await engine.dispose()


async def test_an_agent_s_row_changing_or_going_is_signalled(
    harness: Harness, postgres_url: str
) -> None:
    _, agent_id = await placed(harness)

    async with heard(postgres_url) as signals:
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            # Written but unchanged: nothing to drop.
            await session.execute(
                update(Agent)
                .where(Agent.id == agent_id)
                .values(description=Agent.description)
            )
            await session.execute(
                update(Agent).where(Agent.id == agent_id).values(description="new")
            )
            await session.commit()

    assert signals == [
        {
            "kind": AGENT_CHANGED_SIGNAL,
            "tenant_id": TENANT_ZERO_ID,
            "agent_id": agent_id,
        }
    ]


async def test_only_a_controller_s_authority_changing_is_signalled(
    harness: Harness, postgres_url: str
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
    row = AgentController.id == controller.controller_id

    async with heard(postgres_url) as signals:
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            # What a controller writes as it runs.
            await session.execute(
                update(AgentController).where(row).values(updated_at=func.now())
            )
            await session.execute(
                update(AgentController)
                .where(row)
                .values(revoked_at=func.now(), api_key_id=None)
            )
            await session.commit()
        async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
            await session.execute(delete(AgentController).where(row))
            await session.commit()

    assert (
        signals
        == [
            {
                "kind": CONTROLLER_AUTH_CHANGED_SIGNAL,
                "tenant_id": TENANT_ZERO_ID,
                "controller_id": controller.controller_id,
            }
        ]
        * 2
    )
