"""A turn left queued or running by a host that went away is ended once its
agent is offline and nothing in it has moved for a while; a turn of an agent
that is still connected, or still moving, is left alone."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from switch_core.db.models import (
    AgentConnectionRecord,
    AgentSessionActivityItem,
    AgentSessionPlacement,
    SwitchCoreProcess,
)
from switch_core.session_activity.maintenance import end_orphaned_turns_once
from switch_core.session_activity.service import ORPHANED_TURN_TEXT

from .conftest import AGENT, make_room


async def _turn(service, session_id: str, status: str) -> None:
    await service.report_item(
        AGENT,
        session_id,
        turn_id="turn-1",
        item_id="turn",
        kind="turn",
        revision=3,
        status=status,
        title="Working",
        text="",
        command_id=None,
        room_id=None,
        thread_id=None,
        message_id=None,
        occurred_at=datetime.now(UTC),
        usage=[],
    )


async def _quiet(session_factory, session_id: str, minutes: int = 40) -> None:
    async with session_factory() as db, db.begin():
        await db.execute(
            update(AgentSessionActivityItem)
            .where(AgentSessionActivityItem.session_id == session_id)
            .values(updated_at=datetime.now(UTC) - timedelta(minutes=minutes))
        )


async def _connect(session_factory) -> str:
    """A live connection for the agent, on a process holding its lease."""
    process_id = f"proc-{uuid.uuid4().hex[:8]}"
    connection_id = f"conn-{uuid.uuid4().hex[:8]}"
    async with session_factory() as db, db.begin():
        db.add(SwitchCoreProcess(id=process_id))
        await db.flush()
        db.add(
            AgentConnectionRecord(
                id=connection_id,
                agent_id=AGENT,
                process_id=process_id,
                incarnation=1,
                scope="all",
                delivery_filter="addressed",
                spawn_capable=False,
                transport="sse",
            )
        )
    return connection_id


async def _status(service, session_id: str) -> tuple[str, int, str]:
    [row] = await service.turn_items(AGENT, session_id, "turn-1")
    return row.status, row.revision, row.text


async def test_an_offline_agents_quiet_turn_is_ended(service, session_factory) -> None:
    await _turn(service, "gone", "running")
    await _turn(service, "moving", "running")
    await _turn(service, "done", "completed")
    await _quiet(session_factory, "gone")
    await _quiet(session_factory, "done")

    await end_orphaned_turns_once(session_factory)
    assert await _status(service, "gone") == ("interrupted", 4, ORPHANED_TURN_TEXT)
    assert (await _status(service, "moving"))[0] == "running"
    assert (await _status(service, "done"))[0] == "completed"


async def test_a_connected_agent_keeps_a_turn_its_session_is_still_on(
    service, session_factory
) -> None:
    connection_id = await _connect(session_factory)
    async with session_factory() as db, db.begin():
        room_id = await make_room(db, member=AGENT)
        db.add(
            AgentSessionPlacement(
                agent_id=AGENT,
                session_id="placed",
                room_id=room_id,
                connection_id=connection_id,
            )
        )
    await _turn(service, "placed", "running")
    await _turn(service, "recent", "running")
    await _quiet(session_factory, "placed")
    await _quiet(session_factory, "recent", minutes=20)

    await end_orphaned_turns_once(session_factory)
    assert (await _status(service, "placed"))[0] == "running"
    assert (await _status(service, "recent"))[0] == "running"


async def test_a_connected_agents_dead_session_has_its_turn_ended(
    service, session_factory
) -> None:
    await _connect(session_factory)
    await _turn(service, "faulted", "running")
    await _quiet(session_factory, "faulted")

    await end_orphaned_turns_once(session_factory)
    assert (await _status(service, "faulted"))[0] == "interrupted"
