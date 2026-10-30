"""`list_all_rooms` pages every room oldest first by an opaque cursor, and can
match a name in any case. Real Postgres."""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.db.models import Room, Tenant
from switch_core.db.stores.room_store import RoomStore
from switch_core.tenant_context import tenant_scope
from tests.conftest import RLSHarness

_START = datetime(2026, 1, 1, tzinfo=UTC)


async def _rooms(session_factory: async_sessionmaker[AsyncSession]) -> list[str]:
    names = ["Alpha", "beta", "Gamma alpha", "delta", "ALPHA two", "old alpha"]
    async with session_factory() as session:
        rooms = [
            Room(
                transport_room_id=f"!{index}:test",
                name=name,
                description="",
                # Two rooms share a moment, so the id has to break the tie.
                created_at=_START + timedelta(minutes=min(index, 4)),
                archived_at=_START if name == "old alpha" else None,
            )
            for index, name in enumerate(names)
        ]
        session.add_all(rooms)
        await session.commit()
        return [room.id for room in rooms]


def _list(session_factory: async_sessionmaker[AsyncSession], **kwargs: object):
    protocol = SimpleNamespace(session_factory=session_factory, room_store=RoomStore())
    defaults: dict[str, object] = {
        "include_archived": False,
        "name_contains": None,
        "limit": 100,
        "cursor": None,
    }
    return AgentCore.list_all_rooms(protocol, "agent-1", **{**defaults, **kwargs})  # type: ignore[arg-type]


async def test_pages_walk_every_room_once_in_order(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _rooms(session_factory)
    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        rooms, cursor = await _list(session_factory, limit=2, cursor=cursor)
        seen.extend(room.name for room in rooms)
        pages += 1
        if cursor is None:
            break
    assert pages == 3
    assert sorted(seen) == sorted(
        ["Alpha", "beta", "Gamma alpha", "delta", "ALPHA two"]
    )
    assert seen[:4] == ["Alpha", "beta", "Gamma alpha", "delta"]

    everything, last = await _list(session_factory, include_archived=True)
    assert last is None and len(everything) == 6


async def test_a_name_filter_matches_in_any_case(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _rooms(session_factory)
    rooms, cursor = await _list(session_factory, name_contains="alpha")
    assert {room.name for room in rooms} == {"Alpha", "Gamma alpha", "ALPHA two"}
    assert cursor is None
    archived_too, _ = await _list(
        session_factory, name_contains="ALPHA", include_archived=True
    )
    assert "old alpha" in {room.name for room in archived_too}
    none, cursor = await _list(session_factory, name_contains="no such room")
    assert (none, cursor) == ([], None)


async def test_a_bad_cursor_or_limit_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    await _rooms(session_factory)
    for cursor in ("not-a-cursor", base64.urlsafe_b64encode(b'{"x": 1}').decode()):
        with pytest.raises(ValueError, match="cursor"):
            await _list(session_factory, cursor=cursor)
    for limit in (0, 501):
        with pytest.raises(ValueError, match="limit"):
            await _list(session_factory, limit=limit)


async def _tenant_with_rooms(
    owner: async_sessionmaker[AsyncSession], count: int
) -> str:
    tenant_id = f"tenant-{uuid.uuid4().hex[:8]}"
    async with owner() as session:
        session.add(Tenant(id=tenant_id, slug=tenant_id, name=tenant_id))
        await session.flush()
        session.add_all(
            Room(
                tenant_id=tenant_id,
                transport_room_id=f"!{tenant_id}-{index}:test",
                name=f"{tenant_id} room {index}",
                description="",
                created_at=_START + timedelta(minutes=index),
            )
            for index in range(count)
        )
        await session.commit()
    return tenant_id


async def test_paging_never_crosses_tenants(rls_harness: RLSHarness) -> None:
    """Through the role the policies apply to: a tenant pages only its own
    rooms, and a cursor from another tenant only positions a page in them."""
    tenant_a = await _tenant_with_rooms(rls_harness.owner, 3)
    tenant_b = await _tenant_with_rooms(rls_harness.owner, 3)

    with tenant_scope(tenant_b):
        _, b_cursor = await _list(rls_harness.restricted, limit=1)
    assert b_cursor is not None

    with tenant_scope(tenant_a):
        seen: list[Room] = []
        cursor = None
        while True:
            rooms, cursor = await _list(rls_harness.restricted, limit=2, cursor=cursor)
            seen.extend(rooms)
            if cursor is None:
                break
        foreign, _ = await _list(rls_harness.restricted, cursor=b_cursor)
    assert {room.tenant_id for room in seen} == {tenant_a}
    assert len(seen) == 3
    assert {room.tenant_id for room in foreign} <= {tenant_a}
