from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.db.session_activity_notify_ddl import SESSION_ACTIVITY_CHANNEL
from switch_core.session_activity.listener import AgentSessionActivityListener
from switch_core.tenant_context import current_tenant_id

from .conftest import AGENT, Recorder, make_room
from .test_service import SESSION, _step


def _tenant() -> str:
    tenant = current_tenant_id()
    assert tenant is not None
    return tenant


async def _start(listener: AgentSessionActivityListener) -> None:
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), 5)


@pytest.fixture
def listener(postgres_url) -> AgentSessionActivityListener:
    return AgentSessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )


@pytest.fixture
async def started(listener) -> AsyncIterator[AgentSessionActivityListener]:
    await _start(listener)
    try:
        yield listener
    finally:
        await listener.stop()


@pytest.fixture
async def rooms(session_factory, people) -> tuple[str, str]:
    async with session_factory() as db, db.begin():
        return (
            await make_room(db, member=AGENT),
            await make_room(db, member=AGENT),
        )


async def _report(service, turn_id: str, room_id: str | None) -> None:
    await service.report_item(AGENT, SESSION, **_step(turn_id=turn_id, room_id=room_id))


async def test_a_room_subscriber_hears_only_its_rooms(started, service, rooms):
    x, y = rooms
    everything, in_x = Recorder(), Recorder()
    started.subscribe(_tenant(), everything.on_change, everything.on_resync)
    started.subscribe_rooms(_tenant(), [x], in_x.on_change, in_x.on_resync)

    await _report(service, "in-y", y)
    await _report(service, "nowhere", None)
    await _report(service, "in-x", x)

    await in_x.expect([("activity", "in-x")])
    await everything.expect(
        [("activity", "in-y"), ("activity", "nowhere"), ("activity", "in-x")]
    )


async def test_set_rooms_moves_what_is_heard(started, service, rooms):
    x, y = rooms
    recorder = Recorder()
    subscription = started.subscribe_rooms(
        _tenant(), [x], recorder.on_change, recorder.on_resync
    )
    subscription.set_rooms([y])

    await _report(service, "in-x", x)
    await _report(service, "in-y", y)

    await recorder.expect([("activity", "in-y")])


async def test_the_same_room_in_another_tenant_never_crosses(
    started, service, session_factory, rooms
):
    x, _ = rooms
    recorder = Recorder()
    started.subscribe_rooms(_tenant(), [x], recorder.on_change, recorder.on_resync)
    elsewhere = {
        "tenant_id": "another-tenant",
        "agent_id": AGENT,
        "session_id": SESSION,
        "room_id": x,
        "key": "elsewhere",
    }
    async with session_factory() as db, db.begin():
        await db.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {
                "channel": SESSION_ACTIVITY_CHANNEL,
                "payload": json.dumps(
                    {"table": "session_activity_items", "key": elsewhere}
                ),
            },
        )

    await _report(service, "in-x", x)

    await recorder.expect([("activity", "in-x")])


async def test_resync_reaches_tenant_and_room_subscribers(listener, rooms):
    x, _ = rooms
    everything, in_x = Recorder(), Recorder()
    listener.subscribe(_tenant(), everything.on_change, everything.on_resync)
    listener.subscribe_rooms(_tenant(), [x], in_x.on_change, in_x.on_resync)
    await _start(listener)
    try:
        await everything.expect([])
        await in_x.expect([])
    finally:
        await listener.stop()
    assert (everything.resyncs, in_x.resyncs) == (1, 1)


async def test_closing_leaves_nothing_behind(started, service, rooms):
    x, y = rooms
    closed, open_ = Recorder(), Recorder()
    subscription = started.subscribe_rooms(
        _tenant(), [x, y], closed.on_change, closed.on_resync
    )
    other = started.subscribe_rooms(_tenant(), [x], open_.on_change, open_.on_resync)

    subscription.close()
    await _report(service, "in-x", x)
    await open_.expect([("activity", "in-x")])
    await closed.expect([])

    other.close()
    assert started._room_index == {}
    assert started._room_subscribers == {}
