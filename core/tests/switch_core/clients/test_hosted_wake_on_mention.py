"""Addressing a hosted agent whose cloud worker idled out wakes the worker."""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.clients.agent_client import _WAKING_MESSAGE, AgentClient
from switch_core.db.models import Agent, HostedLaunch, require_tenant_id
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from tests.switch_core.clients.test_agent_client_pool_checkouts import (
    _client,
    _CountingSessionFactory,
    _message,
    _room,
    _seed,
)

LAUNCH_ID = "launch-1"


async def _hosted_client(
    session_factory: async_sessionmaker[AsyncSession], *, sleeping: bool
) -> AgentClient:
    room_id, agents = await _seed(session_factory, names=["member"])
    agent = agents["member"]
    async with session_factory() as session:
        session.add(
            HostedLaunch(
                id=LAUNCH_ID,
                owner_id=agent.owner_id,
                name="member",
                spec={"auto_session": True},
                state="stopped",
                desired_state="stopped",
                sleeping=sleeping,
                agent_id=agent.id,
            )
        )
        row = await session.get(Agent, agent.id)
        assert row is not None
        row.metadata_ = {"hosted_launch_id": LAUNCH_ID}
        await session.commit()
    client = _client(_CountingSessionFactory(session_factory), agent, room_id)
    client._hosted_launch_store = HostedLaunchStore()
    client._waking_notice_revision = None
    client.enqueued = []  # type: ignore[attr-defined]
    client._event_buffer.enqueue = lambda *args: client.enqueued.append(args)  # type: ignore[attr-defined]
    return client


async def _launch(session_factory: async_sessionmaker[AsyncSession]) -> HostedLaunch:
    async with session_factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), LAUNCH_ID))
        assert launch is not None
        return launch


def _sent(client: Any) -> list[str]:
    return [body for body, _live in client.sent]


async def test_mention_wakes_a_sleeping_worker_and_says_so_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = await _hosted_client(session_factory, sleeping=True)

    await client.on_message(_room(), _message("@member can you look at this"))

    assert _sent(client) == ["@louisa " + _WAKING_MESSAGE]
    assert len(client.enqueued) == 1  # type: ignore[attr-defined]
    launch = await _launch(session_factory)
    assert (launch.desired_state, launch.state, launch.sleeping) == (
        "running",
        "queued",
        False,
    )

    await client.on_message(_room(), _message("@member and this too"))

    assert len(_sent(client)) == 1
    assert len(client.enqueued) == 2  # type: ignore[attr-defined]
    assert (await _launch(session_factory)).revision == launch.revision


async def test_mention_never_wakes_a_worker_its_owner_stopped(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    client = await _hosted_client(session_factory, sleeping=False)

    await client.on_message(_room(), _message("@member can you look at this"))

    assert len(_sent(client)) == 1
    assert _WAKING_MESSAGE not in _sent(client)[0]
    launch = await _launch(session_factory)
    assert (launch.desired_state, launch.revision) == ("stopped", 1)
