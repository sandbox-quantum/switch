from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    RoomJoinPayload,
    TaskDelegatePayload,
)
from switch_core.db.models import HostedWakeMailbox, require_tenant_id
from switch_core.db.stores.hosted_mailbox_store import (
    MAILBOX_LIMIT,
    HostedMailboxStore,
    MailboxEntry,
    MailboxFull,
    room_input_id,
)

AGENT = "00000000-0000-4000-8000-00000000000a"


@pytest.fixture
async def mailbox(session_factory):
    return HostedMailboxStore(), session_factory


def message(message_id: str, room: str = "room-1", thread: str | None = None):
    return AgentEvent(
        type="message",
        room_id=room,
        bridge_id=None,
        channel_type=None,
        payload=MessagePayload(
            addressed=True,
            sender="@ana:example.invalid",
            sender_name="Ana",
            message_id=message_id,
            body="hello",
            timestamp=1700000000000,
            thread_id=thread,
        ),
    )


def entry(message_id: str, room: str = "room-1", thread: str | None = None):
    made = MailboxEntry.of(message(message_id, room, thread))
    assert made is not None
    return made


async def write(store, factory, message_id, *, room="room-1"):
    async with factory() as session:
        written = await store.write(
            session, agent_id=AGENT, entry=entry(message_id, room)
        )
        await session.commit()
        return written


async def force(factory, message_id: str, **values: Any) -> None:
    async with factory() as session:
        await session.execute(
            update(HostedWakeMailbox)
            .where(
                HostedWakeMailbox.tenant_id == require_tenant_id(),
                HostedWakeMailbox.message_id == message_id,
            )
            .values(**values)
        )
        await session.commit()


async def states(factory) -> dict[str, str]:
    async with factory() as session:
        rows = await session.execute(
            select(HostedWakeMailbox.message_id, HostedWakeMailbox.state).where(
                HostedWakeMailbox.tenant_id == require_tenant_id()
            )
        )
        return dict(rows.tuples().all())


def test_room_input_id_matches_the_watcher():
    """Vectors computed with `roomInputId` in `host/room-inbox.ts`."""
    task = AgentEvent(
        type="task_delegate",
        room_id="room-1",
        bridge_id=None,
        channel_type=None,
        payload=TaskDelegatePayload(
            task_id="task-1",
            requester_agent_id="agent-a",
            performer_agent_id="agent-b",
            summary="Résumé — «ship it»",
            description="line one\nline two",
        ),
    )
    join = AgentEvent(
        type="room_join",
        room_id="room-1",
        bridge_id=None,
        channel_type=None,
        payload=RoomJoinPayload(
            member="@ana:example.invalid",
            member_name="Ana",
            timestamp=1700000000000,
            listening=True,
        ),
    )
    assert room_input_id(task) == (
        "task_delegate:b35d00e95c27b151af1d551878a35b85c72caf0abab076f7c19f2774cc8b50f0"
    )
    assert room_input_id(join) == (
        "room_join:250b6dd87c453eda5e85209a4de2719caf3838021effb5e0304a0d029abf8768"
    )
    assert room_input_id(message("$m1")) == "$m1"
    unaddressed = message("$m2")
    unaddressed.payload.addressed = False
    assert room_input_id(unaddressed) is None
    assert MailboxEntry.of(unaddressed) is None


def test_entry_carries_thread_and_handoff_shape():
    made = entry("$m1", thread="$root")
    assert made.thread_id == "$root"
    assert made.event["type"] == "message"
    assert made.event["missed"] is None
    assert made.event["payload"]["message_id"] == "$m1"


async def test_write_dedupes_and_waits_pending(mailbox):
    store, factory = mailbox
    assert await write(store, factory, "$m1") is True
    assert await write(store, factory, "$m1") is False
    async with factory() as session:
        row = await session.get(
            HostedWakeMailbox, (require_tenant_id(), AGENT, "room-1", "$m1")
        )
        assert row is not None
        assert (row.state, row.ever_offered, row.offered_to) == ("pending", False, None)
        assert row.expires_at - row.addressed_at == timedelta(hours=24)
    assert await states(factory) == {"$m1": "pending"}


async def test_limit_counts_only_rows_waiting(mailbox):
    store, factory = mailbox
    for index in range(MAILBOX_LIMIT):
        assert await write(store, factory, f"$m{index}") is True
    with pytest.raises(MailboxFull):
        await write(store, factory, "$over")
    assert await write(store, factory, "$m0") is False
    await force(factory, "$m0", state="admitted")
    assert await write(store, factory, "$over") is True
    with pytest.raises(MailboxFull):
        await write(store, factory, "$over-again")


async def test_admit_pending_takes_only_pending_rows_oldest_first(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    await write(store, factory, "$m2", room="room-2")
    await write(store, factory, "$done")
    await force(factory, "$done", state="expired")
    async with factory() as session:
        assert await store.agents_with_pending(session) == [AGENT]
        admitted = await store.admit_pending(session, AGENT)
        await session.commit()
    assert [row.message_id for row in admitted] == ["$m1", "$m2"]
    assert await states(factory) == {
        "$m1": "admitted",
        "$m2": "admitted",
        "$done": "expired",
    }
    async with factory() as session:
        assert await store.agents_with_pending(session) == []


async def test_expiry_by_state(mailbox):
    store, factory = mailbox
    for name in ("$never", "$reclaimed", "$offered", "$accepted", "$held", "$stop"):
        await write(store, factory, name)
    await force(factory, "$reclaimed", ever_offered=True)
    await force(factory, "$offered", state="offered", ever_offered=True)
    await force(factory, "$accepted", state="accepted", ever_offered=True)
    await force(factory, "$held", state="held", ever_offered=True)
    await force(factory, "$stop", state="cancel_requested", cancel_reason="stopped")
    async with factory() as session:
        await session.execute(
            update(HostedWakeMailbox)
            .where(HostedWakeMailbox.tenant_id == require_tenant_id())
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    async with factory() as session:
        notices, tombstoned = await store.expire(session, datetime.now(UTC))
        await session.commit()
    assert {(n.message_id, n.reason) for n in notices} == {
        ("$never", "expired"),
        ("$reclaimed", "expired_uncertain"),
        ("$offered", "expired_uncertain"),
    }
    assert tombstoned == 2
    assert await states(factory) == {
        "$never": "expired",
        "$reclaimed": "expired_uncertain",
        "$offered": "expired_uncertain",
        "$accepted": "cancel_requested",
        "$held": "cancel_requested",
        "$stop": "cancel_requested",
    }
    async with factory() as session:
        owed = await store.owed_notices(session, 100)
    assert {(n.message_id, n.reason) for n in owed} == {
        ("$never", "expired"),
        ("$reclaimed", "expired_uncertain"),
        ("$offered", "expired_uncertain"),
    }
    async with factory() as session:
        await store.notice_posted(
            session, AGENT, "room-1", "expired_uncertain", ["$reclaimed", "$offered"]
        )
        await session.commit()
        remaining = await store.owed_notices(session, 100)
    assert {n.message_id for n in remaining} == {"$never"}


async def test_a_dropped_notice_is_owed_no_more(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    await force(factory, "$m1", state="expired", notice_owed="expired")
    async with factory() as session:
        await store.notice_dropped(
            session, AGENT, "room-1", "expired", ["$m1"], "agent_deleted"
        )
        await session.commit()
        assert await store.owed_notices(session, 100) == []


async def test_tombstone_survives_expiry_and_prune(mailbox):
    store, factory = mailbox
    await write(store, factory, "$tomb")
    await write(store, factory, "$done")
    await write(store, factory, "$recent")
    await force(factory, "$done", state="admitted")
    await force(factory, "$recent", state="admitted")
    old = datetime.now(UTC) - timedelta(days=8)
    await force(
        factory,
        "$tomb",
        state="cancel_requested",
        cancel_reason="stopped",
        addressed_at=old,
        updated_at=old,
        expires_at=old + timedelta(hours=24),
    )
    await force(factory, "$done", updated_at=old)
    async with factory() as session:
        notices, tombstoned = await store.expire(session, datetime.now(UTC))
        pruned = await store.prune(session, datetime.now(UTC))
        await session.commit()
    assert (notices, tombstoned, pruned) == ([], 0, 1)
    assert await states(factory) == {"$tomb": "cancel_requested", "$recent": "admitted"}


async def test_backlog_reports_waiting_and_refusals(mailbox):
    store, factory = mailbox
    since = datetime.now(UTC) - timedelta(seconds=1)
    await write(store, factory, "$m1")
    await write(store, factory, "$m2")
    await write(store, factory, "$m3")
    await force(factory, "$m2", state="offered")
    await force(factory, "$m3", state="refused")
    async with factory() as session:
        (agent,) = await store.backlog(session, since)
    assert (agent.agent_id, agent.waiting, agent.refused) == (AGENT, 2, 1)
    assert agent.oldest is not None
