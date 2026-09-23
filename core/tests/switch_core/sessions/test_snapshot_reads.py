"""Idle reads of a session leave its conversation in the database.

A session's snapshot holds its whole conversation, so it grows for as long as
the session lives. The reads a live worker repeats while nothing is happening —
renewing its lease, asking for commands, asking for its rooms' work, reading
its binding — and a transcript watching for new events need only the session's
own metadata. They select that, and load the whole snapshot only when they go
on to write to it.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select

from switch_core.bridges.agent.protocol.connections import (
    ClientDeclaration,
    ConnectionRegistry,
)
from switch_core.db.models import SdkSession, require_tenant_id
from switch_core.db.stores.agent_session_store import AgentSessionStore
from switch_core.sessions.contract import Snapshot
from switch_core.sessions.service import SessionError

from .test_authority import opened, setup

AGENT = "agent-demo"
SESSION = ("session-demo", "host-demo")
ROOM = "room-demo"
HISTORY = 200

# A column reference to the whole snapshot, as opposed to one reached through
# a JSON subscript or passed to a JSON path function.
_WHOLE_SNAPSHOT = re.compile(
    r"(?<!jsonb_path_query_array\()sdk_sessions\.snapshot(?!\s*(->|\[))"
)


def _history(count: int) -> list[dict]:
    return [
        {
            "itemId": f"item-{index}",
            "turnId": "turn-demo",
            "revision": 1,
            "kind": "assistant-message",
            "status": "completed",
            "title": "Reply",
            "text": "A long reply. " * 50,
            "attachments": [],
            "origin": None,
        }
        for index in range(count)
    ]


async def _grow(session_factory, count: int) -> None:
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        row.snapshot = {**row.snapshot, "items": _history(count)}


async def _stored(session_factory) -> dict:
    async with session_factory() as db:
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        return dict(row.snapshot)


@contextmanager
def _statements(session_factory) -> Iterator[list[str]]:
    engine = session_factory.kw["bind"].sync_engine
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", record)


def _whole_snapshot_reads(statements: list[str]) -> list[str]:
    return [s for s in statements if _WHOLE_SNAPSHOT.search(s)]


def _connection(connections: ConnectionRegistry) -> str:
    connection = connections.open(
        agent_id=AGENT,
        connection_id="connection-demo",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        cursor=0,
        declaration=ClientDeclaration(),
        expected_generation=None,
    )
    connections.claim_room(connection, ROOM)
    return connection.id


async def _lapse_lease(session_factory) -> None:
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)


async def test_idle_reads_select_no_snapshot(session_factory) -> None:
    service, epoch = await setup(session_factory)
    await service.bind_room(AGENT, *SESSION, epoch, ROOM)
    connections = ConnectionRegistry()
    connection_id = _connection(connections)
    await _grow(session_factory, HISTORY)
    through = (await service.snapshot(SESSION[0], "owner")).through_sequence

    with _statements(session_factory) as statements:
        await service.renew(AGENT, *SESSION, epoch)
        assert await service.renew_reporting_room_work(AGENT, *SESSION, epoch) is False
        assert await service.session_room_reservations(AGENT, *SESSION, epoch) == []
        assert await service.pending(AGENT, *SESSION, epoch) == []
        assert await service.bind_connection(
            AGENT, *SESSION, epoch, connection_id, connections
        ) == [ROOM]
        binding = await service.session_binding(AGENT, *SESSION, epoch)
        assert await service.events(SESSION[0], "owner", through) == []
        async with session_factory() as db:
            room = await AgentSessionStore().get_sdk_session_room(db, SESSION[0])

    assert binding.connection_id == connection_id
    assert binding.room_id == ROOM
    assert room == ROOM
    assert any("FOR UPDATE" in s for s in statements)
    assert _whole_snapshot_reads(statements) == []


async def test_the_whole_snapshot_is_still_read_where_it_is_needed(
    session_factory,
) -> None:
    """The check above would pass vacuously if it could not see a snapshot read."""
    service, _ = await setup(session_factory)
    with _statements(session_factory) as statements:
        await service.snapshot(SESSION[0], "owner")
    assert _whole_snapshot_reads(statements)


async def test_an_expired_request_is_cancelled_without_losing_history(
    session_factory,
) -> None:
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    await _grow(session_factory, HISTORY)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        requests = [dict(request) for request in row.snapshot["requests"]]
        requests[0]["expiresAt"] = (
            datetime.now(UTC) - timedelta(seconds=1)
        ).isoformat()
        row.snapshot = {**row.snapshot, "requests": requests}

    first = await service.pending(AGENT, *SESSION, epoch)
    second = await service.pending(AGENT, *SESSION, epoch)

    cancellation = [c for c in first if c.body.type == "turn.interrupt"]
    assert len(cancellation) == 1
    assert cancellation[0].command_id in [c.command_id for c in second]
    snapshot = Snapshot.model_validate(await _stored(session_factory))
    assert len(snapshot.items) == HISTORY
    assert snapshot.requests[0].state == "open"


async def test_a_lapsed_lease_still_takes_the_transcript_offline(
    session_factory,
) -> None:
    service, _ = await setup(session_factory)
    await _grow(session_factory, HISTORY)
    before = Snapshot.model_validate(await _stored(session_factory))
    await _lapse_lease(session_factory)

    events = await service.events(SESSION[0], "owner", before.through_sequence)

    assert [e.body.type for e in events] == ["session.connectivity"]
    after = Snapshot.model_validate(await _stored(session_factory))
    assert after.session.connectivity == "offline"
    assert len(after.items) == HISTORY
    assert await service.events(SESSION[0], "owner", after.through_sequence) == []


async def test_a_stale_host_is_refused_before_anything_is_read(
    session_factory,
) -> None:
    service, epoch = await setup(session_factory)
    for call in (
        service.renew_reporting_room_work,
        service.session_room_reservations,
        service.pending,
        service.session_binding,
    ):
        with pytest.raises(SessionError) as refused:
            await call(AGENT, *SESSION, "stale")
        assert refused.value.code == "STALE_EPOCH"
        with pytest.raises(SessionError) as refused:
            await call("another-agent", *SESSION, epoch)
        assert refused.value.code == "NOT_AUTHORIZED"
    await _lapse_lease(session_factory)
    with pytest.raises(SessionError) as refused:
        await service.renew_reporting_room_work(AGENT, *SESSION, epoch)
    assert refused.value.code == "HOST_OFFLINE"


async def test_invalid_session_metadata_is_still_refused(session_factory) -> None:
    service, epoch = await setup(session_factory)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        row.snapshot = {
            **row.snapshot,
            "session": {**row.snapshot["session"], "status": "unknown"},
        }
    for call in (
        service.renew_reporting_room_work,
        service.session_room_reservations,
        service.pending,
    ):
        with pytest.raises(SessionError) as refused:
            await call(AGENT, *SESSION, epoch)
        assert refused.value.code == "INCOMPATIBLE_SESSION"
    with pytest.raises(SessionError) as refused:
        await service.events(SESSION[0], "owner", 0)
    assert refused.value.code == "INCOMPATIBLE_SESSION"


async def test_an_invalid_open_request_is_still_refused(session_factory) -> None:
    """The requests a timeout could apply to are validated, not trusted."""
    service, epoch = await setup(session_factory)
    await opened(service, epoch)
    async with session_factory() as db, db.begin():
        row = await db.get(SdkSession, (require_tenant_id(), SESSION[0]))
        requests = [dict(request) for request in row.snapshot["requests"]]
        requests[0]["expiresAt"] = "not a timestamp"
        row.snapshot = {**row.snapshot, "requests": requests}
    with pytest.raises(SessionError) as refused:
        await service.pending(AGENT, *SESSION, epoch)
    assert refused.value.code == "INCOMPATIBLE_SESSION"


async def test_a_lean_row_refuses_to_lazy_load_its_snapshot(session_factory) -> None:
    """A write reached without loading the snapshot fails, never loads it quietly."""
    service, _ = await setup(session_factory)
    async with session_factory() as db, db.begin():
        row, _state = await service._locked_state(db, SESSION[0])
        with pytest.raises(Exception, match="snapshot"):
            _ = row.snapshot
    async with session_factory() as db:
        assert await db.scalar(select(SdkSession.id)) == SESSION[0]


async def test_unbound_session_room_is_none(session_factory) -> None:
    await setup(session_factory)
    async with session_factory() as db:
        assert await AgentSessionStore().get_sdk_session_room(db, SESSION[0]) is None
        assert await AgentSessionStore().get_sdk_session_room(db, "missing") is None
