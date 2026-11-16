"""A template run retried with its run key, through the gateway route and the
real management service: the retry answers with the agent the first attempt
made instead of refusing its name as taken. Without the key, the second
request is a run of its own and is refused as before."""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.operations import context as op_context
from switch_core.db.models import Agent
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.rooms import router as rooms_router
from switch_core.management.template_updates import BUDDY_ID
from switch_core.official_templates import official_template
from tests.switch_core.management.harness import (
    Harness,
    add_member,
    build_harness,
    cookies_for,
    enroll_console,
)
from tests.switch_core.management.test_agent_operations import _NoRooms, _online


@pytest.fixture(autouse=True)
def _short_listen(monkeypatch: pytest.MonkeyPatch) -> None:
    from switch_core.gateway import rooms as gateway_rooms

    monkeypatch.setattr(gateway_rooms, "LISTEN_TIMEOUT_SECONDS", 0.1)


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Iterator[Harness]:
    harness = build_harness(session_factory)
    harness.protocol.config.feature_flags = {  # type: ignore[attr-defined]
        "agent_management": True,
        "switch_buddy": True,
        "additional_agent_providers": True,
    }
    previous = op_context._protocol
    op_context.init_operations_protocol(harness.protocol)
    harness.gateway_app.include_router(rooms_router, prefix="/rooms")
    harness.gateway_app.dependency_overrides[gw_deps.get_room_yaml_service] = lambda: (
        _NoRooms()
    )
    harness.gateway_app.dependency_overrides[gw_deps.get_room_store] = RoomStore
    harness.gateway_app.dependency_overrides[gw_deps.get_agent_store] = AgentStore
    try:
        yield harness
    finally:
        op_context._protocol = previous


@pytest.fixture
async def client(harness: Harness) -> AsyncIterator[httpx.AsyncClient]:
    async with harness.client() as client:
        yield client


def _buddy_content() -> str:
    buddy = official_template(BUDDY_ID, True, switch_buddy=True)
    assert buddy is not None
    return buddy.content


async def _run(
    client: httpx.AsyncClient, owner: object, run_key: str | None
) -> httpx.Response:
    path = "/gateway/rooms/from-template-document"
    if run_key is not None:
        path += f"?run_key={run_key}"
    return await client.post(
        path,
        json={
            "template": _buddy_content(),
            "template_name": "switch-buddy",
            "inputs": {"agent_name": "switch-buddy-ada", "provider": "claude"},
        },
        cookies=cookies_for(owner),  # type: ignore[arg-type]
    )


async def _agents_named(harness: Harness, name: str) -> int:
    async with harness.session_factory() as session:
        return (
            await session.execute(
                select(func.count()).select_from(Agent).where(Agent.name == name)
            )
        ).scalar_one()


async def test_a_retry_with_the_run_key_answers_with_what_the_first_made(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    controller = await enroll_console(harness, client, owner, name="laptop-ada")
    await _online(client, controller)

    first = await _run(client, owner, "console-run-1")
    again = await _run(client, owner, "console-run-1")

    assert first.status_code == 201, first.text
    assert again.status_code == 201, again.text
    assert (
        again.json()["created_agents"][0]["agent_id"]
        == first.json()["created_agents"][0]["agent_id"]
    )
    assert await _agents_named(harness, "switch-buddy-ada") == 1

    so_far = await client.get(
        "/gateway/rooms/from-template/runs/console-run-1", cookies=cookies_for(owner)
    )
    assert so_far.status_code == 200, so_far.text
    assert so_far.json()["in_flight"] is False
    assert [a["name"] for a in so_far.json()["agents"]] == ["switch-buddy-ada"]


async def test_without_a_run_key_the_second_request_is_refused_as_taken(
    harness: Harness, client: httpx.AsyncClient
) -> None:
    owner = await add_member(harness.session_factory, "ada")
    controller = await enroll_console(harness, client, owner, name="laptop-ada")
    await _online(client, controller)

    first = await _run(client, owner, None)
    again = await _run(client, owner, None)

    assert first.status_code == 201, first.text
    assert again.status_code == 409
    assert again.json()["code"] == "agents_not_created"
