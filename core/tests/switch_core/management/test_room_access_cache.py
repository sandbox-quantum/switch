"""What a post checks first, kept until a signal says it changed: against
Postgres, with the triggers, and a real signal bus where a test needs one.

A second check of the same membership, or of a post by an agent no budget
covers, reaches no database; a membership removed, a room archived or a
budget set is heard by every process, which then reads again.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest
from sqlalchemy import delete, func, insert, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.room_access_cache import RoomAccessCache
from switch_core.db.models import TENANT_ZERO_ID, Room, UsageBudget, room_agents
from switch_core.db.session_scope import tenant_session
from tests.session_counting import CountingSessionFactory
from tests.switch_core.bridges.agent.protocol.test_pool_checkouts import (
    _seed,
    _service,
)
from tests.switch_core.management.harness import Harness
from tests.switch_core.management.test_controller_auth_cache import heard, listening

__all__ = ["listening"]


def _kept(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[AgentCore, RoomAccessCache, CountingSessionFactory]:
    counting = CountingSessionFactory(session_factory)
    service = _service(counting)
    service.room_access = RoomAccessCache(ttl_seconds=5, max_entries=64)
    return service, service.room_access, counting


async def _budget(
    session_factory: async_sessionmaker[AsyncSession], agent_id: str | None
) -> None:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            insert(UsageBudget).values(
                agent_id=agent_id,
                metric="messages",
                model="",
                amount_limit=5,
                period_hours=24,
            )
        )
        await session.commit()


async def _until(condition: Callable[[], bool]) -> None:
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("never happened")


async def test_a_second_check_reaches_no_database(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, member_id, _ = await _seed(session_factory)
    service, cache, counting = _kept(session_factory)

    first = await service.require_room_poster(member_id, room_id)
    opened = counting.opened
    again = await service.require_room_poster(member_id, room_id)
    member = await service.require_room_member(member_id, room_id)

    assert opened == 1
    assert counting.opened == 1
    assert first == again == member
    assert cache.unbudgeted(TENANT_ZERO_ID, member_id)


async def test_a_post_by_an_agent_a_budget_covers_is_checked_every_time(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, member_id, _ = await _seed(session_factory)
    await _budget(session_factory, member_id)
    service, cache, counting = _kept(session_factory)

    for _ in range(2):
        await service.require_room_poster(member_id, room_id)

    assert counting.opened == 2
    assert cache.member(TENANT_ZERO_ID, member_id, room_id) is not None
    assert not cache.unbudgeted(TENANT_ZERO_ID, member_id)


async def test_a_refusal_is_never_kept(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room_id, _, outsider_id = await _seed(session_factory)
    service, cache, counting = _kept(session_factory)

    for _ in range(2):
        with pytest.raises(PermissionError):
            await service.require_room_member(outsider_id, room_id)

    assert counting.opened == 2
    assert cache.member(TENANT_ZERO_ID, outsider_id, room_id) is None


@pytest.mark.parametrize("change", ["leave", "archive", "budget"])
async def test_a_change_made_where_nothing_announces_it_is_heard(
    listening: Harness, change: str
) -> None:
    """Made straight in the database, as an operator in psql would: the
    triggers tell every process."""
    room_id, member_id, _ = await _seed(listening.session_factory)
    service, cache, _ = _kept(listening.session_factory)
    cache.follow(listening.bus)
    # The seed's own signals arrive after it commits, and a check read while
    # one arrives is not kept, so the check is made until one is.
    for _ in range(100):
        await service.require_room_poster(member_id, room_id)
        if cache.member(TENANT_ZERO_ID, member_id, room_id) is not None:
            break
        await asyncio.sleep(0.02)
    assert cache.member(TENANT_ZERO_ID, member_id, room_id) is not None
    assert cache.unbudgeted(TENANT_ZERO_ID, member_id)

    if change == "budget":
        await _budget(listening.session_factory, None)
        await _until(lambda: not cache.unbudgeted(TENANT_ZERO_ID, member_id))
        return
    async with tenant_session(listening.session_factory, TENANT_ZERO_ID) as session:
        if change == "leave":
            await session.execute(
                delete(room_agents).where(
                    room_agents.c.room_id == room_id,
                    room_agents.c.agent_id == member_id,
                )
            )
        else:
            await session.execute(
                update(Room).where(Room.id == room_id).values(archived_at=func.now())
            )
        await session.commit()

    await _until(lambda: cache.member(TENANT_ZERO_ID, member_id, room_id) is None)
    if change == "leave":
        with pytest.raises(PermissionError):
            await service.require_room_poster(member_id, room_id)
    else:
        room = await service.require_room_member(member_id, room_id)
        assert room.archived


async def test_the_triggers_send_what_a_check_depends_on(
    session_factory: async_sessionmaker[AsyncSession], postgres_url: str
) -> None:
    room_id, member_id, _ = await _seed(session_factory)
    # One transaction each: identical notifications sent in one transaction
    # are delivered once.
    changes = [
        # A column no check reads: nothing.
        update(Room).where(Room.id == room_id).values(instructions="be brief"),
        update(Room).where(Room.id == room_id).values(name="renamed"),
        delete(room_agents).where(room_agents.c.agent_id == member_id),
        insert(room_agents).values(room_id=room_id, agent_id=member_id),
        insert(UsageBudget).values(
            agent_id=member_id,
            metric="messages",
            model="",
            amount_limit=5,
            period_hours=1,
        ),
    ]

    async with heard(postgres_url) as signals:
        for change in changes:
            async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
                await session.execute(change)
                await session.commit()

    room_agent = {
        "kind": "room_agent.changed",
        "tenant_id": TENANT_ZERO_ID,
        "room_id": room_id,
        "agent_id": member_id,
    }
    assert signals == [
        {"kind": "room.changed", "tenant_id": TENANT_ZERO_ID, "room_id": room_id},
        room_agent,
        room_agent,
        {"kind": "budgets.changed", "tenant_id": TENANT_ZERO_ID},
    ]
