"""The snapshot's counts must not multiply by the number of tenants.

This is the regression test for the defect a review found: every query in
`collect_tenant_counts` leaned on row-level security to narrow it, and the
policy is exactly what does *not* apply on an owner connection. A fan-out that
binds each tenant in turn then reads every tenant's rows on every pass, so a
deployment with N tenants reported N times its real size — silently, because a
count has no shape that looks wrong.

`db/tenant_lookup.py` states the rule and every other fan-out in the tree
follows it. These tests exist because the single-tenant tests next door cannot
fail on it: with one tenant, N == 1.

The default `session_factory` fixture connects as the owner, which is the
connection where the bug was reachable — so this file needs no special
harness to reproduce it. That is the point: CI runs the vulnerable shape.
"""

from __future__ import annotations

import contextlib
import logging
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    Client,
    ClientRoom,
    Message,
    Room,
    Tenant,
)
from switch_core.db.session_scope import tenant_session
from switch_core.telemetry import snapshot as snapshot_module
from switch_core.telemetry.snapshot import collect_usage, newly_active_rooms

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
OTHER_TENANT = "11111111-1111-1111-1111-111111111111"


def _tenant_session_that_fails_for(bad_tenant_id: str):
    """A drop-in `tenant_session` that raises while binding one tenant.

    Stands in for the real failure modes named in the review — a statement
    timeout, a binding error — without needing to reproduce one against the
    test database: whatever the cause, it surfaces the same way, as an
    exception out of the `async with tenant_session(...)` block.
    """

    @contextlib.asynccontextmanager
    async def flaky(
        factory: async_sessionmaker[AsyncSession], tenant_id: str
    ) -> AsyncIterator[AsyncSession]:
        if tenant_id == bad_tenant_id:
            raise RuntimeError("simulated per-tenant failure")
        async with tenant_session(factory, tenant_id) as session:
            yield session

    return flaky


async def _make_tenant(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(
            Tenant(id=OTHER_TENANT, name="second", slug=f"s-{uuid.uuid4().hex[:8]}")
        )
        await session.commit()


async def _room_with_a_conversation(
    session_factory: async_sessionmaker[AsyncSession],
    tenant_id: str,
    *,
    first_at: datetime,
) -> None:
    """One room, one human, one agent, one human message."""
    async with tenant_session(session_factory, tenant_id) as session:
        room = Room(
            matrix_room_id=f"!{uuid.uuid4().hex[:10]}:test",
            name=f"room-{uuid.uuid4().hex[:6]}",
            description="a room",
            channel_type="channel_public",
            created_at=NOW - timedelta(days=2),
            metadata_={"created_by_kind": "user"},
        )
        human = Client(
            matrix_user_id=f"@human-{uuid.uuid4().hex[:8]}:test",
            display_name="a person",
            type="user",
        )
        agent = Client(
            matrix_user_id=f"@agent-{uuid.uuid4().hex[:8]}:test",
            display_name="an agent",
            type="agent",
        )
        session.add_all([room, human, agent])
        await session.flush()
        session.add_all(
            [
                ClientRoom(client_id=human.id, room_id=room.id),
                ClientRoom(client_id=agent.id, room_id=room.id),
            ]
        )
        session.add(
            Message(
                room_id=room.id,
                seq=1,
                transport_event_id=f"$evt-{uuid.uuid4().hex}",
                sender_id=human.matrix_user_id,
                sender_client_id=human.id,
                event_type="m.room.message",
                msgtype="m.text",
                body="hello",
                content={"body": "hello"},
                sent_at=first_at,
            )
        )
        await session.commit()


class TestCountsDoNotMultiplyByTenant:
    async def test_two_tenants_with_one_room_each_report_two_rooms(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )
        await _room_with_a_conversation(
            session_factory, OTHER_TENANT, first_at=NOW - timedelta(hours=1)
        )

        counts = await collect_usage(session_factory, now=NOW)

        assert counts.tenant_count == 2
        # Two, not four. Without the tenant predicate each pass saw both rooms.
        assert counts.room_count == 2
        assert counts.room_active_1d == 2
        assert counts.user_active_1d == 2
        assert counts.message_count_1d == 2
        assert counts.room_membership_total == 2

    async def test_one_tenants_room_is_not_counted_by_the_other(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The sharper version: the second tenant owns nothing at all, so every
        count must be exactly what the first tenant has."""
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )

        counts = await collect_usage(session_factory, now=NOW)

        assert counts.tenant_count == 2
        assert counts.room_count == 1
        assert counts.room_active_7d == 1
        assert counts.user_active_7d == 1
        assert counts.message_count_1d == 1


class TestRoomActivationIsNotReportedPerTenant:
    async def test_a_room_is_reported_once_not_once_per_tenant(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """`room_became_active` is emitted per returned row, so a duplicate here
        is a duplicated analytics event, not just a wrong count."""
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )

        found = await newly_active_rooms(
            session_factory, since=NOW - timedelta(hours=4), now=NOW
        )

        assert len(found) == 1


class TestOneTenantsFailureIsContained:
    """The regression test for the second defect a review found: nothing
    guarded the per-tenant fan-out, so one tenant raising — a statement
    timeout, a binding failure — took the whole pass down with it. A
    deterministically-failing tenant meant the watermark never advanced and no
    snapshot was ever sent again; see `TestTheSnapshotSchedule` in
    `test_deployment_and_reporter.py` for that half."""

    async def test_the_other_tenants_counts_still_arrive(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )
        await _room_with_a_conversation(
            session_factory, OTHER_TENANT, first_at=NOW - timedelta(hours=1)
        )
        monkeypatch.setattr(
            snapshot_module,
            "tenant_session",
            _tenant_session_that_fails_for(OTHER_TENANT),
        )

        counts = await collect_usage(session_factory, now=NOW)

        # The healthy tenant's room and message are still in the total.
        assert counts.room_count == 1
        assert counts.room_active_1d == 1
        assert counts.message_count_1d == 1

    async def test_a_partial_pass_is_disclosed_not_folded_into_the_full_count(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Before this fix, `tenant_count` was set to the deployment's real
        tenant count up front — so a partial pass reported the full tenant
        count sitting on top of an undercounted everything else, with nothing
        on the wire to tell the two apart. It must now report only what was
        actually counted, and the failure must also reach the operator's log."""
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )
        monkeypatch.setattr(
            snapshot_module,
            "tenant_session",
            _tenant_session_that_fails_for(OTHER_TENANT),
        )

        with caplog.at_level(logging.ERROR, logger="switch_core.telemetry.snapshot"):
            counts = await collect_usage(session_factory, now=NOW)

        assert counts.tenant_count == 1
        # And the pass says how many it lost, rather than leaving a reader to
        # work it out from a tenant count the event does not otherwise carry.
        assert counts.tenant_failed_count == 1
        assert any(OTHER_TENANT in record.message for record in caplog.records)

    async def test_a_complete_pass_reports_nothing_failed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """Zero rather than an absent property: every `usage_snapshot` carries
        the same keys, so a gap in the data is a send that went wrong rather
        than a pass nobody thought about."""
        await _make_tenant(session_factory)

        counts = await collect_usage(session_factory, now=NOW)

        assert counts.tenant_failed_count == 0

    async def test_the_pass_reports_how_long_it_took(
        self,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """Roughly fifteen queries per tenant against the database that is also
        serving rooms. What that costs at scale is an open question in
        `docs/old/telemetry-events.md`, and a background task is invisible to
        the HTTP histogram that times everything else."""
        await _make_tenant(session_factory)

        counts = await collect_usage(session_factory, now=NOW)

        # A whole, non-negative number of milliseconds — the contract, not a
        # value a test can pin. Zero is legitimate for an empty deployment.
        assert isinstance(counts.duration_ms, int)
        assert counts.duration_ms >= 0
        assert "duration_ms" in counts.as_event_properties(session_live_count=0)

    async def test_newly_active_rooms_is_contained_the_same_way(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _make_tenant(session_factory)
        await _room_with_a_conversation(
            session_factory, TENANT_ZERO_ID, first_at=NOW - timedelta(hours=1)
        )
        await _room_with_a_conversation(
            session_factory, OTHER_TENANT, first_at=NOW - timedelta(hours=1)
        )
        monkeypatch.setattr(
            snapshot_module,
            "tenant_session",
            _tenant_session_that_fails_for(OTHER_TENANT),
        )

        with caplog.at_level(logging.ERROR, logger="switch_core.telemetry.snapshot"):
            found = await newly_active_rooms(
                session_factory, since=NOW - timedelta(hours=4), now=NOW
            )

        assert len(found) == 1
        assert any(OTHER_TENANT in record.message for record in caplog.records)
