"""Switching a room's tool text off edits no message already posted; what is
drawn after it shows no tool text.

Switching off changes only the room's setting: no activity row is updated, so
no change is announced and nothing redraws a turn for the switch-off itself,
even in a publisher that has restarted and remembers nothing it drew. The key
the publisher compares does not follow what a tool step shows either. The
publisher reads the flag from the room's row each time it draws, so the tool
text still stored is drawn as nothing while the room is off, and shown again
once it is back on.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.bridges.collaboration.adapter import TurnActivity
from switch_core.db.models import AgentSessionActivityItem
from switch_core.db.stores.room_store import RoomStore
from switch_core.session_activity import publisher as publisher_module
from switch_core.session_activity.bridge_turns import status_state, turn_view
from switch_core.session_activity.listener import AgentSessionActivityListener
from switch_core.session_activity.publisher import AgentSessionActivityPublisher
from switch_core.tenant_context import current_tenant_id

from .bridge_fixtures import BridgedRoom, Drawn, RecordingPlatform, make_bridged_room
from .conftest import AGENT

SESSION = "session-demo"
# Another session of the same agent in the same room: a turn reported in it
# leaves the stop control of `SESSION`'s turns as it was.
OTHER_SESSION = "session-other"
_SECRET = "$ cat .env\nTOKEN=abc"
_DEADLINE_SECONDS = 60.0


@pytest.fixture
async def bridged(session_factory, people) -> BridgedRoom:
    async with session_factory() as db, db.begin():
        bridged = await make_bridged_room(db, member=AGENT)
        await RoomStore().set_show_tool_io(db, bridged.room_id, True)
    return bridged


@pytest.fixture
async def listener(postgres_url) -> AsyncIterator[AgentSessionActivityListener]:
    listener = AgentSessionActivityListener(
        lambda: create_async_engine(postgres_url, poolclass=NullPool)
    )
    await listener.start()
    await asyncio.wait_for(listener.connected.wait(), 5)
    try:
        yield listener
    finally:
        await listener.stop()


@pytest.fixture
def platform() -> RecordingPlatform:
    return RecordingPlatform()


@pytest.fixture
async def publisher(
    session_factory, bridged, listener, platform
) -> AsyncIterator[AgentSessionActivityPublisher]:
    tenant = current_tenant_id()
    assert tenant is not None
    publisher = AgentSessionActivityPublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        bridge_type="slack",
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
        agent_online=lambda _agent_id: True,
    )
    publisher.start()
    try:
        yield publisher
    finally:
        await publisher.stop()


async def _report(
    service,
    room_id: str,
    turn_id: str,
    *,
    item_id: str,
    kind: str,
    status: str,
    revision: int = 1,
    tool_io: str | None = None,
    session: str = SESSION,
) -> None:
    await service.report_item(
        AGENT,
        session,
        turn_id=turn_id,
        item_id=item_id,
        kind=kind,
        revision=revision,
        status=status,
        title=f"{item_id} of {turn_id}",
        text="",
        tool_io=tool_io,
        command_id="command-1" if kind == "turn" else None,
        room_id=room_id,
        thread_id=None,
        message_id=None,
        occurred_at=datetime.now(UTC),
        usage=[],
    )


async def _turn(
    service,
    room_id: str,
    turn_id: str,
    *,
    ended: bool,
    detail: bool,
    session: str = SESSION,
) -> None:
    """A turn with one tool step, showing text when `detail`."""
    await _report(
        service,
        room_id,
        turn_id,
        item_id="turn",
        kind="turn",
        status="running",
        session=session,
    )
    await _report(
        service,
        room_id,
        turn_id,
        item_id="tool-1",
        kind="tool-activity",
        status="completed",
        tool_io=_SECRET if detail else None,
        session=session,
    )
    if ended:
        await _report(
            service,
            room_id,
            turn_id,
            item_id="turn",
            kind="turn",
            status="completed",
            revision=2,
            session=session,
        )


async def _switch_off(session_factory, room_id: str) -> None:
    async with session_factory() as db, db.begin():
        await RoomStore().set_show_tool_io(db, room_id, False)


def _turn_draws(platform: RecordingPlatform, since: int = 0) -> list[Drawn]:
    return [
        drawn
        for drawn in platform.drawn[since:]
        if isinstance(drawn.content, TurnActivity) and not drawn.content.status_only
    ]


def _of(draws: list[Drawn], turn_id: str) -> list[Drawn]:
    return [d for d in draws if d.content.turn.turn_id == turn_id]


def _texts(drawn: Drawn) -> list[str]:
    return [i.text for i in drawn.content.items if i.kind == "tool-activity"]


async def _until(check: Callable[[], bool], seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not check():
        assert time.monotonic() < deadline, "timed out"
        await asyncio.sleep(0.02)


async def _settled(platform: RecordingPlatform, turns: set[str]) -> int:
    """Wait until every turn's message shows how it stands; where draws begin next."""

    def drawn() -> bool:
        return {d.content.turn.turn_id for d in _turn_draws(platform)} >= turns

    await _until(drawn, _DEADLINE_SECONDS)
    count = -1
    while count != len(platform.drawn):
        count = len(platform.drawn)
        await asyncio.sleep(0.3)
    return count


# ── The key the publisher compares ────────────────────────────────────────────


def _row(item_id: str, kind: str, text: str) -> AgentSessionActivityItem:
    now = datetime.now(UTC)
    return AgentSessionActivityItem(
        agent_id=AGENT,
        session_id=SESSION,
        turn_id="turn-1",
        item_id=item_id,
        kind=kind,
        revision=1,
        status="running" if kind == "turn" else "completed",
        title=item_id,
        text=text,
        room_id="room",
        occurred_at=now,
        created_at=now,
        updated_at=now,
    )


def _state(rows: list[AgentSessionActivityItem], *, show_tool_io: bool) -> str:
    view = turn_view(rows, show_tool_io=show_tool_io)
    assert view is not None
    return status_state(
        view,
        elapsed_seconds=None,
        interrupt_turn_id=None,
        clock_redraws=False,
        closed_by_platform=False,
    )


def test_the_read_gate_drops_only_tool_text() -> None:
    rows = [
        _row("turn", "turn", ""),
        _row("tool-1", "tool-activity", _SECRET),
        _row("said-1", "assistant-message", "Reading the config"),
        _row("asked-1", "user-message", "What is in .env?"),
    ]
    shown = turn_view(rows, show_tool_io=True)
    hidden = turn_view(rows, show_tool_io=False)
    assert shown is not None and hidden is not None
    assert [i.text for i in shown.items] == [
        _SECRET,
        "Reading the config",
        "What is in .env?",
    ]
    assert [i.text for i in hidden.items] == [
        "",
        "Reading the config",
        "What is in .env?",
    ]


def test_the_key_does_not_follow_tool_text() -> None:
    showing = [_row("turn", "turn", ""), _row("tool-1", "tool-activity", _SECRET)]
    never = [_row("turn", "turn", ""), _row("tool-1", "tool-activity", "")]

    # Shown, hidden on read or never stored: the same key, so hiding the text
    # alone is no reason to redraw a message.
    assert _state(showing, show_tool_io=True) == "running::/tool-1:1"
    assert _state(showing, show_tool_io=False) == "running::/tool-1:1"
    assert _state(never, show_tool_io=True) == "running::/tool-1:1"
    assert _state(never, show_tool_io=False) == "running::/tool-1:1"


# ── No edit of a posted message for the switch-off ───────────────────────────


async def test_switching_off_edits_no_message_already_posted(
    service, publisher, platform, bridged, session_factory
) -> None:
    await _turn(service, bridged.room_id, "live", ended=False, detail=True)
    await _turn(service, bridged.room_id, "ended", ended=True, detail=True)
    before = await _settled(platform, {"live", "ended"})
    for turn_id in ("live", "ended"):
        assert _texts(_of(_turn_draws(platform), turn_id)[-1]) == [_SECRET]

    await _switch_off(session_factory, bridged.room_id)
    # Asked about anyway, neither turn has anything to redraw.
    for turn_id in ("live", "ended"):
        publisher._enqueue(("turn", AGENT, SESSION, turn_id), publisher_module._NOW)
    # A turn reported after the switch-off, drawn behind those, as a marker.
    # It is in another session: one in `SESSION` would change the turn the
    # running turn's stop control names, and redraw it for that.
    await _turn(
        service,
        bridged.room_id,
        "after",
        ended=True,
        detail=True,
        session=OTHER_SESSION,
    )
    mark = await _settled(platform, {"after"})

    after = _turn_draws(platform, before)
    # No `update_rich`, nor any draw, of a turn posted before the switch-off.
    assert {d.content.turn.turn_id for d in after} == {"after"}
    assert all(_texts(d) == [""] for d in after)

    # A change of its own still redraws the running turn, now without text.
    await _report(
        service,
        bridged.room_id,
        "live",
        item_id="turn",
        kind="turn",
        status="completed",
        revision=2,
    )
    await _until(lambda: bool(_of(_turn_draws(platform, mark), "live")))
    await _settled(platform, set())
    redrawn = _of(_turn_draws(platform, mark), "live")
    assert {d.call for d in redrawn} == {"update_rich"}
    assert all(_texts(d) == [""] for d in redrawn)
    assert _of(_turn_draws(platform, mark), "ended") == []


# ── The read gate, on tool text stored before the switch-off ─────────────────


def _unstarted_publisher(
    session_factory, bridged: BridgedRoom, listener, platform
) -> AgentSessionActivityPublisher:
    tenant = current_tenant_id()
    assert tenant is not None
    return AgentSessionActivityPublisher(
        adapter=platform,  # type: ignore[arg-type]
        bridge_id=bridged.bridge_id,
        bridge_type="slack",
        tenant_id=tenant,
        listener=listener,
        session_factory=session_factory,
        agent_online=lambda _agent_id: True,
    )


async def _stored_tool_texts(session_factory, room_id: str, turn_id: str) -> list[str]:
    async with session_factory() as db:
        rows = await db.execute(
            select(AgentSessionActivityItem.text).where(
                AgentSessionActivityItem.room_id == room_id,
                AgentSessionActivityItem.turn_id == turn_id,
                AgentSessionActivityItem.kind == "tool-activity",
            )
        )
        return list(rows.scalars())


async def test_a_room_that_is_off_draws_and_returns_no_stored_tool_text(
    service, bridged, listener, platform, session_factory
) -> None:
    # Stored through the write gate while the room shows it, then switched off.
    await _turn(service, bridged.room_id, "kept", ended=True, detail=True)
    await _switch_off(session_factory, bridged.room_id)
    assert await _stored_tool_texts(session_factory, bridged.room_id, "kept") == [
        _SECRET
    ]

    # Drawing the turn (`_publish_turn`), found by the start's resync.
    publisher = _unstarted_publisher(session_factory, bridged, listener, platform)
    publisher.start()
    try:
        await _settled(platform, {"kept"})
        draws = _of(_turn_draws(platform), "kept")
        assert draws
        assert all(_texts(d) == [""] for d in draws)
        posted = draws[0]

        # Reading back what the message shows (`_turn_at`).
        snapshot = await publisher.activity_shown_at(bridged.channel_id, posted.ref)
        assert snapshot is not None
        assert [i.text for i in snapshot.items if i.kind == "tool-activity"] == [""]

        # The row still holds the text: switched back on, the room returns it.
        async with session_factory() as db, db.begin():
            await RoomStore().set_show_tool_io(db, bridged.room_id, True)
        shown = await publisher.activity_shown_at(bridged.channel_id, posted.ref)
        assert shown is not None
        assert [i.text for i in shown.items if i.kind == "tool-activity"] == [_SECRET]
    finally:
        await publisher.stop()


# ── A restarted publisher, then the switch-off ───────────────────────────────


async def test_a_switch_off_after_a_restart_edits_no_message_already_posted(
    service, bridged, listener, platform, session_factory
) -> None:
    """A publisher that restarted remembers nothing it drew, so any change
    announced for a posted turn would redraw it; the switch-off announces
    none."""
    first = _unstarted_publisher(session_factory, bridged, listener, platform)
    first.start()
    try:
        await _turn(service, bridged.room_id, "ended", ended=True, detail=True)
        await _settled(platform, {"ended"})
        assert _texts(_of(_turn_draws(platform), "ended")[-1]) == [_SECRET]
    finally:
        await first.stop()

    # The bridge process restarted: a new publisher, nothing remembered.
    second = _unstarted_publisher(session_factory, bridged, listener, platform)
    second.start()
    try:
        mark = await _settled(platform, set())
        await _switch_off(session_factory, bridged.room_id)
        # A turn reported after the switch-off, in another session, drawn
        # behind anything the switch-off would have announced: a marker.
        await _turn(
            service,
            bridged.room_id,
            "after",
            ended=True,
            detail=True,
            session=OTHER_SESSION,
        )
        await _until(lambda: bool(_of(_turn_draws(platform, mark), "after")))
        await _settled(platform, set())

        after = _turn_draws(platform, mark)
        # No `update_rich`, nor any draw, of the turn posted before.
        assert _of(after, "ended") == []
        assert {d.content.turn.turn_id for d in after} == {"after"}
        # Drawn as its rows arrive (an early draw may predate its tool step);
        # none shows tool text, and the last shows the step without it.
        assert all(_SECRET not in _texts(d) for d in after)
        assert _texts(after[-1]) == [""]
    finally:
        await second.stop()
    assert await _stored_tool_texts(session_factory, bridged.room_id, "ended") == [
        _SECRET
    ]
