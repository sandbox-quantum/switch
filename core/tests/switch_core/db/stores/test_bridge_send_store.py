from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.send_ledger import StoredSendLedger
from switch_core.db.models import (
    TENANT_ZERO_ID,
    BridgeHourlySend,
    Client,
    CollaborationBridge,
)
from switch_core.db.stores.bridge_send_store import BridgeSendStore

NUMBER = "+14155550101"


async def make_bridge(session_factory: async_sessionmaker[AsyncSession]) -> str:
    async with session_factory() as session:
        client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge client",
            type="bridge",
        )
        session.add(client)
        await session.flush()
        bridge = CollaborationBridge(
            type="sms", display_name="SMS", client_id=client.id, status="active"
        )
        session.add(bridge)
        await session.commit()
        return bridge.id


def ledger(
    session_factory: async_sessionmaker[AsyncSession], bridge_id: str
) -> StoredSendLedger:
    return StoredSendLedger(
        session_factory=session_factory, tenant_id=TENANT_ZERO_ID, bridge_id=bridge_id
    )


async def test_spends_add_up_per_recipient_and_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    one = ledger(session_factory, await make_bridge(session_factory))
    other = ledger(session_factory, await make_bridge(session_factory))
    assert await one.spent(NUMBER) == 0
    assert await one.spend(NUMBER, 2) == 2
    assert await one.spend(NUMBER, 3) == 5
    assert await one.spent(NUMBER) == 5
    assert await one.spent("+14155550102") == 0
    assert await other.spent(NUMBER) == 0


async def test_concurrent_spends_are_all_counted(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    shared = ledger(session_factory, await make_bridge(session_factory))
    totals = await asyncio.gather(*(shared.spend(NUMBER, 1) for _ in range(10)))
    assert sorted(totals) == list(range(1, 11))


async def test_a_refund_takes_back_what_was_spent_and_no_more(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    one = ledger(session_factory, await make_bridge(session_factory))
    await one.refund(NUMBER, 1)  # nothing spent this hour
    assert await one.spent(NUMBER) == 0
    await one.spend(NUMBER, 3)
    await one.refund(NUMBER, 2)
    assert await one.spent(NUMBER) == 1
    await one.refund(NUMBER, 5)
    assert await one.spent(NUMBER) == 0


async def test_an_earlier_hour_does_not_count_and_is_cleared(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bridge_id = await make_bridge(session_factory)
    async with session_factory() as session:
        session.add(
            BridgeHourlySend(
                bridge_id=bridge_id,
                recipient=NUMBER,
                hour=datetime.now(UTC) - timedelta(hours=2),
                units=99,
                told_limit=True,
            )
        )
        await session.commit()
    shared = ledger(session_factory, bridge_id)
    assert await shared.spent(NUMBER) == 0
    assert await shared.spend(NUMBER, 1) == 1
    async with session_factory() as session:
        rows = (await session.scalars(select(BridgeHourlySend))).all()
    assert [row.units for row in rows] == [1]


async def test_the_limit_notice_is_claimed_once_an_hour(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bridge_id = await make_bridge(session_factory)
    one, other = ledger(session_factory, bridge_id), ledger(session_factory, bridge_id)
    assert not await one.claim_limit_notice(NUMBER)  # nothing spent this hour
    await one.spend(NUMBER, 1)
    claims = await asyncio.gather(
        one.claim_limit_notice(NUMBER), other.claim_limit_notice(NUMBER)
    )
    assert sorted(claims) == [False, True]
    await other.release_limit_notice(NUMBER)
    assert await one.claim_limit_notice(NUMBER)


async def test_rows_go_with_their_bridge(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    bridge_id = await make_bridge(session_factory)
    await ledger(session_factory, bridge_id).spend(NUMBER, 1)
    async with session_factory() as session:
        await session.execute(
            delete(CollaborationBridge).where(CollaborationBridge.id == bridge_id)
        )
        await session.commit()
        assert (
            await BridgeSendStore().spent(
                session, bridge_id=bridge_id, recipient=NUMBER
            )
            == 0
        )
        assert (await session.scalars(select(BridgeHourlySend))).all() == []
