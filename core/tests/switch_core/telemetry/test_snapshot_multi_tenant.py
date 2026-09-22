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

import uuid
from datetime import UTC, datetime, timedelta

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
from switch_core.telemetry.snapshot import collect_usage, newly_active_rooms

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
OTHER_TENANT = "11111111-1111-1111-1111-111111111111"


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
