"""Messages waiting for the decision service, on real Postgres: claimed one
per room in order, leased rather than held, expired by age, finished once,
and kept apart by workspace."""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, PendingDecision, Room, Tenant
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.pending_decision_store import Pending, PendingDecisionStore

STORE = PendingDecisionStore()
TENANT_B = "pending-store-tenant-b"


async def _room(
    session_factory: async_sessionmaker[AsyncSession], tenant_id: str = TENANT_ZERO_ID
) -> str:
    async with tenant_session(session_factory, tenant_id) as session:
        room = Room(
            transport_room_id=f"!r-{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="d",
        )
        session.add(room)
        await session.commit()
        return room.id


async def _add(
    session_factory: async_sessionmaker[AsyncSession],
    room_id: str,
    seq: int,
    tenant_id: str = TENANT_ZERO_ID,
) -> None:
    async with tenant_session(session_factory, tenant_id) as session:
        await STORE.add(
            session,
            tenant_id=tenant_id,
            room_id=room_id,
            room_seq=seq,
            message_key=f"$m{seq}",
        )
        await session.commit()


async def _claim(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str = TENANT_ZERO_ID,
    *,
    limit: int = 10,
) -> list[Pending]:
    async with tenant_session(session_factory, tenant_id) as session:
        claimed = await STORE.claim(
            session, tenant_id=tenant_id, lease_seconds=60, limit=limit
        )
        await session.commit()
        return claimed


async def test_one_message_per_room_oldest_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    ops, sales = await _room(session_factory), await _room(session_factory)
    await _add(session_factory, ops, 5)
    await _add(session_factory, ops, 7)
    await _add(session_factory, sales, 3)

    first = await _claim(session_factory)
    again = await _claim(session_factory)

    assert sorted((p.room_id, p.room_seq) for p in first) == sorted(
        [(ops, 5), (sales, 3)]
    )
    # The room's next message waits until its first is settled.
    assert again == []
    async with session_factory() as session:
        assert await STORE.finish(
            session, tenant_id=TENANT_ZERO_ID, pending=Pending(ops, 5, "$m5")
        )
        await session.commit()
    assert await _claim(session_factory) == [Pending(ops, 7, "$m7")]


async def test_a_lapsed_lease_is_claimed_again(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await _room(session_factory)
    await _add(session_factory, room, 1)
    assert len(await _claim(session_factory)) == 1
    async with session_factory() as session:
        await session.execute(
            update(PendingDecision).values(
                claimed_until=func.now() - timedelta(seconds=1)
            )
        )
        await session.commit()

    assert await _claim(session_factory) == [Pending(room, 1, "$m1")]


async def test_finish_says_whether_the_row_was_still_there(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await _room(session_factory)
    await _add(session_factory, room, 1)
    pending = Pending(room, 1, "$m1")

    async with session_factory() as session:
        assert await STORE.finish(session, tenant_id=TENANT_ZERO_ID, pending=pending)
        assert not await STORE.finish(
            session, tenant_id=TENANT_ZERO_ID, pending=pending
        )
        await session.commit()


async def test_old_rows_expire_and_young_ones_stay(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await _room(session_factory)
    await _add(session_factory, room, 1)
    await _add(session_factory, room, 2)
    async with session_factory() as session:
        await session.execute(
            update(PendingDecision)
            .where(PendingDecision.room_seq == 1)
            .values(created_at=func.now() - timedelta(minutes=3))
        )
        await session.commit()

    async with session_factory() as session:
        expired = await STORE.expire(
            session, tenant_id=TENANT_ZERO_ID, max_age_seconds=120
        )
        await session.commit()
        left = (await session.scalars(select(PendingDecision.room_seq))).all()

    assert expired == [Pending(room, 1, "$m1")]
    assert left == [2]


async def test_each_workspace_claims_only_its_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        session.add(Tenant(id=TENANT_B, slug=TENANT_B, name=TENANT_B))
        await session.commit()
    mine = await _room(session_factory)
    theirs = await _room(session_factory, TENANT_B)
    await _add(session_factory, mine, 1)
    await _add(session_factory, theirs, 1, TENANT_B)

    assert [p.room_id for p in await _claim(session_factory)] == [mine]
    assert [p.room_id for p in await _claim(session_factory, TENANT_B)] == [theirs]


async def test_a_deleted_room_takes_its_waiting_messages_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    room = await _room(session_factory)
    await _add(session_factory, room, 1)

    async with session_factory() as session:
        found = await session.get(Room, room)
        await session.delete(found)
        await session.commit()
        assert (await session.scalars(select(PendingDecision))).all() == []
