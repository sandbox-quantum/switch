"""A cloud machine's controller that reconnects with no cursor gets what arrived
while it was down (`management/wake_replay.py`): above all the message that
woke the machine, which "I'll pick this up as soon as it's back" promised.

Against Postgres, through the real connection route, Core's controller stream
and event buffer, as `test_stream.py` reads them.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    AgentController,
    CloudMachine,
    MachineWorkspace,
)
from switch_core.db.session_scope import tenant_session
from switch_core.management import wake_replay
from tests.db_buffer import age_events
from tests.switch_core.management.harness import (
    EnrolledController,
    Harness,
    add_member,
    add_room,
    build_harness,
    enroll_console,
    open_connection,
    open_stream,
    place_agent,
    take,
)
from tests.switch_core.management.test_stream import _ask


@pytest.fixture
def harness(session_factory: async_sessionmaker[AsyncSession]) -> Harness:
    return build_harness(session_factory)


def _ago(**delta: float) -> datetime:
    return datetime.now(UTC) - timedelta(**delta)


async def _on_cloud_machine(
    harness: Harness,
    controller: EnrolledController,
    *,
    last_seen_at: datetime | None,
    reported_at: datetime | None = None,
    started_at: datetime | None = None,
) -> None:
    """Put the controller on a cloud machine, as its box enrolled it, and say
    when it was last seen (None: never, as a controller enrolled afresh)."""
    now = datetime.now(UTC)
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        machine = CloudMachine(
            id=str(uuid4()),
            owner_id=controller.owner.id,
            state="ready",
            desired_state="running",
            revision=1,
            backend="box",
            active_at=started_at or now,
            created_at=now,
            updated_at=now,
        )
        session.add(machine)
        await session.flush()
        workspace = MachineWorkspace(
            id=str(uuid4()),
            machine_id=machine.id,
            owner_id=controller.owner.id,
            controller_id=controller.controller_id,
            created_at=now,
        )
        session.add(workspace)
        await session.flush()
        if reported_at is not None:
            machine.heartbeat = {
                "controllers": {workspace.id: {"at": reported_at.isoformat()}}
            }
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller.controller_id)
            .values(last_seen_at=last_seen_at, disconnected_at=None)
        )
        await session.commit()


async def _set_last_seen(harness: Harness, controller_id: str, at: datetime) -> None:
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(AgentController)
            .where(AgentController.id == controller_id)
            .values(last_seen_at=at)
        )
        await session.commit()


async def _setup(harness: Harness) -> tuple[EnrolledController, str, str]:
    owner = await add_member(harness.session_factory, "ada")
    async with harness.client() as client:
        controller = await enroll_console(harness, client, owner)
        agent_id = await place_agent(client, controller, name="reviewer")
    room_id = await add_room(harness.session_factory, agent_id)
    return controller, agent_id, room_id


async def _reconnect(
    harness: Harness,
    controller: EnrolledController,
    cursors: dict[str, int | str],
    frames: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Open the connection with `cursors`, take `frames` frames, and check
    nothing else follows. Returns the attach and the events sent."""
    async with harness.client() as client:
        opened = await open_connection(client, controller, cursors)
    stream = await open_stream(harness, controller, opened)
    try:
        taken = await take(stream, frames)
        with pytest.raises(asyncio.TimeoutError):
            await take(stream, 1, timeout=0.5)
    finally:
        await stream.aclose()  # type: ignore[attr-defined]
    [attached] = [data for name, data in taken if name == "agent.attached"]
    events = [data for name, data in taken if name == "agent.event"]
    return attached, events


def _bodies(events: list[dict[str, Any]]) -> list[str]:
    return [e["event"]["payload"]["body"] for e in events]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_message_that_woke_the_box_is_sent_after_a_reconnect_with_no_cursor(
    harness: Harness,
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(minutes=40))
    woke = await _ask(harness, agent_id, room_id, "hello, are you there?")

    attached, events = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert attached["from_seq"] == woke - 1
    assert [e["seq"] for e in events] == [woke]
    assert _bodies(events) == ["hello, are you there?"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_controllers_own_cursor_always_wins(harness: Harness) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(minutes=40))
    seq = await _ask(harness, agent_id, room_id, "already taken")

    attached, events = await _reconnect(harness, controller, {agent_id: seq}, 2)

    assert attached["from_seq"] == seq
    assert events == []


@pytest.mark.usefixtures("hosted_v2_on")
async def test_what_came_before_it_went_down_is_not_sent_again(
    harness: Harness,
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _ask(harness, agent_id, room_id, "before the sleep")
    await age_events(harness.session_factory, agent_id, seconds=3600)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(minutes=40))
    woke = await _ask(harness, agent_id, room_id, "after it")

    attached, events = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert attached["from_seq"] == woke - 1
    assert _bodies(events) == ["after it"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_long_sleep_sends_at_most_the_newest_twenty(
    harness: Harness, caplog: pytest.LogCaptureFixture
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(hours=2))
    seqs = [await _ask(harness, agent_id, room_id, f"m{i}") for i in range(25)]

    with caplog.at_level(logging.WARNING, logger=wake_replay.__name__):
        attached, events = await _reconnect(
            harness, controller, {agent_id: "head"}, 2 + wake_replay.REPLAY_LIMIT
        )

    assert attached["from_seq"] == seqs[5] - 1
    assert _bodies(events) == [f"m{i}" for i in range(5, 25)]
    assert "only the newest 20 are sent" in caplog.text


@pytest.mark.usefixtures("hosted_v2_on")
async def test_nothing_older_than_a_day_is_sent(harness: Harness) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _ask(harness, agent_id, room_id, "two days ago")
    await age_events(harness.session_factory, agent_id, seconds=30 * 3600)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(days=3))
    await _ask(harness, agent_id, room_id, "today")

    _, events = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert _bodies(events) == ["today"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_reconnect_before_confirming_gets_the_same_event_again(
    harness: Harness,
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(minutes=40))
    woke = await _ask(harness, agent_id, room_id, "wake up")
    first, sent = await _reconnect(harness, controller, {agent_id: "head"}, 3)
    # It reported meanwhile, so its last-seen time is now past the message,
    # and then dropped before confirming anything.
    await _set_last_seen(harness, controller.controller_id, datetime.now(UTC))

    again, resent = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert first["from_seq"] == again["from_seq"] == woke - 1
    assert [e["seq"] for e in sent] == [e["seq"] for e in resent] == [woke]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_controller_enrolled_afresh_counts_from_the_machines_last_report(
    harness: Harness,
) -> None:
    """The new controller has no history of its own, so the box's last
    report for this workspace says when it went down."""
    controller, agent_id, room_id = await _setup(harness)
    await _ask(harness, agent_id, room_id, "handled by the old controller")
    await age_events(harness.session_factory, agent_id, seconds=3600)
    await _on_cloud_machine(
        harness, controller, last_seen_at=None, reported_at=_ago(minutes=40)
    )
    await _ask(harness, agent_id, room_id, "after the pause")

    _, events = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert _bodies(events) == ["after the pause"]


@pytest.mark.usefixtures("hosted_v2_on")
async def test_a_revived_box_counts_from_shortly_before_it_was_started(
    harness: Harness,
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _ask(harness, agent_id, room_id, "long ago")
    await age_events(harness.session_factory, agent_id, seconds=3600)
    await _on_cloud_machine(
        harness, controller, last_seen_at=None, started_at=_ago(seconds=5)
    )
    await _ask(harness, agent_id, room_id, "the one that revived it")

    _, events = await _reconnect(harness, controller, {agent_id: "head"}, 3)

    assert _bodies(events) == ["the one that revived it"]


async def test_a_controller_on_its_owners_own_computer_starts_at_its_head(
    harness: Harness,
) -> None:
    controller, agent_id, room_id = await _setup(harness)
    await _set_last_seen(harness, controller.controller_id, _ago(minutes=40))
    seq = await _ask(harness, agent_id, room_id, "while the laptop was shut")

    attached, events = await _reconnect(harness, controller, {agent_id: "head"}, 2)

    assert attached["from_seq"] == seq
    assert events == []


async def test_with_hosted_agents_v2_off_it_starts_at_its_head(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    from switch_core import hosted_v2

    controller, agent_id, room_id = await _setup(harness)
    await _on_cloud_machine(harness, controller, last_seen_at=_ago(minutes=40))
    async with tenant_session(harness.session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(CloudMachine)
            .where(CloudMachine.owner_id == controller.owner.id)
            .values(backend="vm")
        )
        await session.commit()
    seq = await _ask(harness, agent_id, room_id, "v1 as before")
    monkeypatch.setattr(hosted_v2, "_process_on", False)

    attached, events = await _reconnect(harness, controller, {agent_id: "head"}, 2)

    assert attached["from_seq"] == seq
    assert events == []
