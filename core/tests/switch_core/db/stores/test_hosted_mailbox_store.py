from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessagePayload,
    RoomJoinPayload,
    TaskDelegatePayload,
)
from switch_core.db.models import (
    HostedLaunch,
    HostedWakeMailbox,
    User,
    require_tenant_id,
)
from switch_core.db.stores.hosted_launch_store import HostedLaunchStore
from switch_core.db.stores.hosted_mailbox_store import (
    MAILBOX_LIMIT,
    HostedMailboxStore,
    MailboxEntry,
    MailboxFull,
    MailboxNotice,
    one_per_room,
    room_input_id,
)

AGENT = "00000000-0000-4000-8000-00000000000a"
LAUNCH = "mailbox-launch"


@pytest.fixture
async def mailbox(session_factory):
    async with session_factory() as session:
        session.add(
            User(
                id="mailbox-owner",
                name="Owner",
                email="mailbox@example.com",
                role="user",
                password_hash="unused",
            )
        )
        await session.flush()
        session.add(
            HostedLaunch(
                id=LAUNCH,
                owner_id="mailbox-owner",
                name="mailbox-helper",
                spec={},
                state="ready",
                agent_id=AGENT,
            )
        )
        await session.commit()
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


async def write(store, factory, message_id, *, room="room-1", offered_to=None):
    async with factory() as session:
        written = await store.write(
            session,
            agent_id=AGENT,
            launch_id=LAUNCH,
            entry=entry(message_id, room),
            offered_to=offered_to,
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


async def ack(store, factory, *acks):
    async with factory() as session:
        result = await store.ack(session, AGENT, list(acks))
        await session.commit()
        return result


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
    assert made.wire()["message_id"] == "$m1"


async def test_write_dedupes_and_offers_when_a_worker_takes_it(mailbox):
    store, factory = mailbox
    assert await write(store, factory, "$m1") is True
    assert await write(store, factory, "$m1") is False
    assert await write(store, factory, "$m2", offered_to="1:conn:7") is True
    async with factory() as session:
        offered = await session.get(
            HostedWakeMailbox, (require_tenant_id(), AGENT, "room-1", "$m2")
        )
        assert offered is not None
        assert (offered.state, offered.ever_offered, offered.offered_to) == (
            "offered",
            True,
            "1:conn:7",
        )
        assert offered.offered_until is not None
        assert offered.expires_at - offered.addressed_at == timedelta(hours=24)
    assert await states(factory) == {"$m1": "pending", "$m2": "offered"}


async def test_limit_counts_only_rows_waiting_for_the_worker(mailbox):
    store, factory = mailbox
    for index in range(MAILBOX_LIMIT):
        assert await write(store, factory, f"$m{index}") is True
    with pytest.raises(MailboxFull):
        await write(store, factory, "$over")
    assert await write(store, factory, "$m0") is False
    await force(factory, "$m0", state="accepted")
    assert await write(store, factory, "$over") is True
    with pytest.raises(MailboxFull):
        await write(store, factory, "$over-again")


async def test_offer_moves_only_pending_rows(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    await write(store, factory, "$m2")
    await ack(store, factory, ("room-1", "$m2", "journaled"))
    async with factory() as session:
        moved = await store.mark_offered(
            session, AGENT, [("room-1", "$m1"), ("room-1", "$m2")], "1:conn:1"
        )
        await session.commit()
    assert moved == {("room-1", "$m1")}
    assert await states(factory) == {"$m1": "offered", "$m2": "accepted"}


async def test_offer_ack_race_never_regresses(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1", offered_to="1:old:1")
    await force(factory, "$m1", offered_until=datetime.now(UTC) - timedelta(seconds=1))
    async with factory() as session:
        assert await store.reclaim(session, AGENT, {}) == 1
        await session.commit()
    await ack(store, factory, ("room-1", "$m1", "journaled"))
    async with factory() as session:
        assert await store.pending(session, AGENT) == []
        assert (
            await store.mark_offered(session, AGENT, [("room-1", "$m1")], "x") == set()
        )
        await session.commit()
    assert await states(factory) == {"$m1": "accepted"}


async def test_reclaim_keeps_only_live_unexpired_leases(mailbox):
    store, factory = mailbox
    await write(store, factory, "$live", offered_to="2:conn:5")
    await write(store, factory, "$foreign-boot", offered_to="1:conn:5")
    await write(store, factory, "$old-generation", offered_to="2:conn:4")
    await write(store, factory, "$lapsed", offered_to="2:conn:5")
    await force(
        factory, "$lapsed", offered_until=datetime.now(UTC) - timedelta(seconds=1)
    )
    async with factory() as session:
        assert await store.reclaim(session, None, {AGENT: "2:conn:5"}) == 3
        await session.commit()
    assert await states(factory) == {
        "$live": "offered",
        "$foreign-boot": "pending",
        "$old-generation": "pending",
        "$lapsed": "pending",
    }
    async with factory() as session:
        row = await session.get(
            HostedWakeMailbox, (require_tenant_id(), AGENT, "room-1", "$lapsed")
        )
        assert row is not None
        assert (row.offered_to, row.ever_offered) == (None, True)
        assert await store.agents_with_pending(session) == [AGENT]


async def test_ack_moves_forward_only(mailbox):
    store, factory = mailbox
    for name in ("$a", "$b", "$c", "$d"):
        await write(store, factory, name, offered_to="1:conn:1")
    after, notices = await ack(
        store,
        factory,
        ("room-1", "$a", "journaled"),
        ("room-1", "$a", "admitted"),
        ("room-1", "$b", "duplicate"),
        ("room-1", "$c", "refused"),
        ("room-1", "$d", "journaled"),
        ("room-1", "$d", "held"),
        ("room-1", "$unknown", "journaled"),
    )
    assert notices == []
    assert after == {
        ("room-1", "$a"): "admitted",
        ("room-1", "$b"): "accepted",
        ("room-1", "$c"): "refused",
        ("room-1", "$d"): "held",
    }
    await ack(
        store,
        factory,
        ("room-1", "$a", "journaled"),
        ("room-1", "$c", "journaled"),
        ("room-1", "$d", "journaled"),
        ("room-1", "$b", "cancelled"),
    )
    assert await states(factory) == {
        "$a": "admitted",
        "$b": "accepted",
        "$c": "refused",
        "$d": "held",
    }
    await ack(store, factory, ("room-1", "$d", "admitted"))
    assert (await states(factory))["$d"] == "admitted"


async def test_stop_cancels_never_offered_rows_and_tombstones_the_rest(mailbox):
    store, factory = mailbox
    await write(store, factory, "$never", room="room-1")
    await write(store, factory, "$never-2", room="room-2")
    await write(store, factory, "$reclaimed", offered_to="1:conn:1")
    await force(factory, "$reclaimed", state="pending", offered_to=None)
    await write(store, factory, "$offered", offered_to="1:conn:1")
    await write(store, factory, "$accepted", offered_to="1:conn:1")
    await write(store, factory, "$held", offered_to="1:conn:1")
    await write(store, factory, "$admitted", offered_to="1:conn:1")
    await ack(
        store,
        factory,
        ("room-1", "$accepted", "journaled"),
        ("room-1", "$held", "journaled"),
        ("room-1", "$held", "held"),
        ("room-1", "$admitted", "journaled"),
        ("room-1", "$admitted", "admitted"),
    )
    async with factory() as session:
        split = await store.stop(session, LAUNCH)
        await session.commit()
    assert [(n.room_id, n.message_id, n.reason) for n in split.cancelled] == [
        ("room-1", "$never", "stopped"),
        ("room-2", "$never-2", "stopped"),
    ]
    assert sorted(split.cancel_requested) == [
        ("room-1", "$accepted"),
        ("room-1", "$held"),
        ("room-1", "$offered"),
        ("room-1", "$reclaimed"),
    ]
    assert await states(factory) == {
        "$never": "cancelled",
        "$never-2": "cancelled",
        "$reclaimed": "cancel_requested",
        "$offered": "cancel_requested",
        "$accepted": "cancel_requested",
        "$held": "cancel_requested",
        "$admitted": "admitted",
    }
    async with factory() as session:
        cancelled = await store.cancelled_entries(session, AGENT)
    assert {(e["message_id"], e["reason"]) for e in cancelled} == {
        ("$reclaimed", "stopped"),
        ("$offered", "stopped"),
        ("$accepted", "stopped"),
        ("$held", "stopped"),
    }

    # A tombstone is settled only by the watcher, never by a late ack.
    await ack(store, factory, ("room-1", "$offered", "journaled"))
    assert (await states(factory))["$offered"] == "cancel_requested"

    _, notices = await ack(
        store,
        factory,
        ("room-1", "$offered", "cancelled"),
        ("room-1", "$accepted", "admitted"),
    )
    assert {(n.message_id, n.reason) for n in notices} == {
        ("$offered", "stopped"),
        ("$accepted", "started_before_stop"),
    }
    _, again = await ack(store, factory, ("room-1", "$offered", "cancelled"))
    assert again == []


async def test_stop_after_stop_leaves_settled_rows(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    async with factory() as session:
        await store.stop(session, LAUNCH)
        second = await store.stop(session, LAUNCH)
        await session.commit()
    assert second.cancelled == [] and second.cancel_requested == []
    assert await states(factory) == {"$m1": "cancelled"}


async def test_expiry_by_state(mailbox):
    store, factory = mailbox
    for name in ("$never", "$reclaimed", "$offered", "$accepted", "$held", "$stop"):
        await write(
            store, factory, name, offered_to=None if name == "$never" else "1:c:1"
        )
    await force(factory, "$reclaimed", state="pending", offered_to=None)
    await ack(
        store,
        factory,
        ("room-1", "$accepted", "journaled"),
        ("room-1", "$held", "journaled"),
        ("room-1", "$held", "held"),
    )
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
        reasons = {
            e["message_id"]: e["reason"]
            for e in await store.cancelled_entries(session, AGENT)
        }
    assert reasons == {"$accepted": "expired", "$held": "expired", "$stop": "stopped"}
    _, settled = await ack(
        store,
        factory,
        ("room-1", "$held", "cancelled"),
        ("room-1", "$accepted", "admitted"),
    )
    assert {(n.message_id, n.reason) for n in settled} == {
        ("$held", "expired"),
        ("$accepted", "started_before_expiry"),
    }
    async with factory() as session:
        owed = await store.owed_notices(session, 100)
    assert {(n.message_id, n.reason) for n in owed} == {
        ("$never", "expired"),
        ("$reclaimed", "expired_uncertain"),
        ("$offered", "expired_uncertain"),
        ("$held", "expired"),
        ("$accepted", "started_before_expiry"),
    }
    async with factory() as session:
        await store.notice_posted(
            session, AGENT, "room-1", "expired_uncertain", ["$reclaimed", "$offered"]
        )
        await session.commit()
        remaining = await store.owed_notices(session, 100)
    assert {n.message_id for n in remaining} == {"$never", "$held", "$accepted"}


async def test_tombstone_survives_expiry_and_prune(mailbox):
    store, factory = mailbox
    await write(store, factory, "$tomb", offered_to="1:c:1")
    await write(store, factory, "$done", offered_to="1:c:1")
    await write(store, factory, "$recent", offered_to="1:c:1")
    await ack(store, factory, ("room-1", "$done", "admitted"))
    await ack(store, factory, ("room-1", "$recent", "admitted"))
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
    async with factory() as session:
        assert [
            e["message_id"] for e in await store.cancelled_entries(session, AGENT)
        ] == ["$tomb"]


async def test_busy_counts_rows_waiting_for_the_worker(mailbox):
    store, factory = mailbox
    registry = ConnectionRegistry()

    async def evidence() -> tuple[bool, list[str]]:
        async with factory() as session:
            launch = await session.get(HostedLaunch, (require_tenant_id(), LAUNCH))
            assert launch is not None
            found = await HostedLaunchStore().idle_evidence(session, launch, registry)
            return await store.busy(session, LAUNCH), found.reasons

    assert await evidence() == (False, ["no_fresh_report"])
    await write(store, factory, "$m1")
    for state in ("pending", "offered", "accepted"):
        await force(factory, "$m1", state=state)
        assert await evidence() == (True, ["no_fresh_report", "mailbox_pending"])
    for state in ("held", "cancel_requested", "admitted"):
        await force(factory, "$m1", state=state)
        assert await evidence() == (False, ["no_fresh_report"])


async def test_backlog_reports_waiting_and_refusals(mailbox):
    store, factory = mailbox
    since = datetime.now(UTC) - timedelta(seconds=1)
    await write(store, factory, "$m1")
    await write(store, factory, "$m2", offered_to="1:c:1")
    await write(store, factory, "$m3", offered_to="1:c:1")
    await ack(store, factory, ("room-1", "$m3", "refused"))
    async with factory() as session:
        (agent,) = await store.backlog(session, since)
    assert (agent.agent_id, agent.waiting, agent.refused) == (AGENT, 2, 1)
    assert agent.oldest is not None


async def test_delete_launch_drops_rows_without_notices(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    await force(factory, "$m1", state="cancel_requested", cancel_reason="stopped")
    async with factory() as session:
        await store.delete_launch(session, LAUNCH)
        await session.commit()
    assert await states(factory) == {}


async def test_rows_go_with_their_launch(mailbox):
    store, factory = mailbox
    await write(store, factory, "$m1")
    async with factory() as session:
        launch = await session.get(HostedLaunch, (require_tenant_id(), LAUNCH))
        await session.delete(launch)
        await session.commit()
    assert await states(factory) == {}


def test_one_notice_per_room_and_reason():
    notices = [
        MailboxNotice(
            agent_id=AGENT,
            room_id=room,
            message_id=message_id,
            thread_id=None,
            reason=reason,
        )
        for room, message_id, reason in (
            ("room-1", "$a", "stopped"),
            ("room-1", "$b", "stopped"),
            ("room-2", "$c", "stopped"),
            ("room-1", "$d", "expired"),
        )
    ]
    kept = one_per_room(notices)
    assert [(n.room_id, n.message_id) for n in kept] == [
        ("room-1", "$b"),
        ("room-2", "$c"),
        ("room-1", "$d"),
    ]
