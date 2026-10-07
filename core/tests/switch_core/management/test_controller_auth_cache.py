"""The controller-token cache, end to end: what it saves, and what it must not.

Against Postgres, through the real bearer middleware and the real management
authenticator. Round trips are counted at the cursor, so "avoids the
database" means no statement reached Postgres.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from switch_core.bridges.agent.auth import BearerAuthMiddleware
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore
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
            TENANT_ZERO_ID, controller.controller_id, controller.credential_id
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
            TENANT_ZERO_ID, controller.controller_id, controller.credential_id
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
