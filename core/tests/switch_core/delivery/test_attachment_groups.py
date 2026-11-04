"""Several files posted as one message reach an agent as one message.

Each file is a row of its own in the room, written one after another and
sharing a group marker. The router decides the post once, as a whole: in the
transaction that writes the file completing it, or, when the rest never
comes, once the post has waited `ATTACHMENT_GROUP_TIMEOUT_SECONDS` since its
first file, with the files that did arrive and a note saying how many. What
is waited on is a row in `pending_attachment_groups`, not memory, so any
process can decide a post another started.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    AgentEventRow,
    Client,
    Message,
    PendingAttachmentGroup,
    Room,
)
from switch_core.db.session_scope import tenant_session
from switch_core.delivery import router as router_module
from switch_core.delivery.recipient import AgentRecipient
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


class _Scene:
    def __init__(
        self, process: Process, room: Room, alice: Client, agent: Agent
    ) -> None:
        self.process = process
        self.room = room
        self.alice = alice
        self.agent = agent

    async def part(
        self,
        index: int,
        total: int,
        group: str,
        filename: str,
        *,
        caption: str | None = None,
    ) -> str:
        return await self.process.send_file(
            self.room,
            filename,
            sender=self.alice,
            caption=caption,
            group={"id": group, "index": index, "total": total},
        )


async def _scene(
    session_factory: async_sessionmaker[AsyncSession], *, channel_type: str
) -> _Scene:
    process = process_on(session_factory)
    room = await make_room(session_factory, channel_type=channel_type)
    alice = await make_person(session_factory, "alice")
    agent, client = await make_agent(session_factory, "agent-a")
    await add_member(session_factory, room, alice)
    await add_member(session_factory, room, client, agent=agent)
    # Live, so the report says the agent could take what it was asked.
    process.connections.open(
        agent_id=agent.id,
        connection_id="c1",
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    return _Scene(process, room, alice, agent)


@pytest.fixture
async def scene(session_factory: async_sessionmaker[AsyncSession]) -> _Scene:
    return await _scene(session_factory, channel_type="channel_public")


@pytest.fixture
def long_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    """Posts wait a minute for their missing files, so no file a test sends
    arrives after its post's deadline however busy the machine is. The wait
    ends when the test says so, in `_after_the_wait`."""
    monkeypatch.setattr(router_module, "ATTACHMENT_GROUP_TIMEOUT_SECONDS", 60.0)


async def _events(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> list[AgentEvent]:
    """What the router stored for the agent. Only what is for the agent is
    stored; the rest of the room is read from the room's log by whoever
    wants it. So a test about what a post becomes addresses the post to the
    agent, in its caption (part 0's body)."""
    return [
        AgentEvent.model_validate(row.payload)
        for row in await own_events(session_factory, scene.agent.id)
    ]


def _payload(event: AgentEvent) -> MessagePayload:
    assert isinstance(event.payload, MessagePayload)
    return event.payload


async def _pending(session_factory: async_sessionmaker[AsyncSession]) -> list[Any]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        return list((await session.scalars(select(PendingAttachmentGroup))).all())


async def _after_the_wait(scene: _Scene) -> None:
    """Every waiting post's deadline passes, and the sweep every process runs
    decides them.

    The deadline is moved rather than waited on, as a timer short enough to
    wait on can fire before a test has sent the files it means to arrive in
    time. That the timer itself decides a post is
    `test_the_timer_decides_a_post_whose_wait_is_over`'s to show.
    """
    session_factory = scene.process.session_factory
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(PendingAttachmentGroup).values(
                deadline=PendingAttachmentGroup.deadline - timedelta(minutes=10)
            )
        )
        await session.commit()
    await scene.process.router.flush_due_groups(TENANT_ZERO_ID)
    await scene.process.idle()


async def test_grouped_media_coalesces_into_one_event(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    parts = ["cat.png", "notes.md", "data.csv"]

    for index, name in enumerate(parts):
        await scene.part(
            index,
            3,
            "grp-1",
            name,
            caption="@agent-a three files" if index == 0 else None,
        )
        if index < 2:
            assert await _events(session_factory, scene) == []

    events = await _events(session_factory, scene)
    assert len(events) == 1
    payload = _payload(events[0])
    assert [a.filename for a in payload.attachments] == [
        "cat.png",
        "notes.md",
        "data.csv",
    ]
    assert payload.body == "@agent-a three files"
    assert await _pending(session_factory) == []


async def test_grouped_media_coalesces_out_of_order(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    names = {0: "a.png", 1: "b.png", 2: "c.png"}

    for index in [1, 0, 2]:
        await scene.part(
            index,
            3,
            "grp-2",
            names[index],
            caption="@agent-a captioned" if index == 0 else None,
        )

    events = await _events(session_factory, scene)
    assert len(events) == 1
    payload = _payload(events[0])
    # Sorted by group index, not arrival order.
    assert [a.filename for a in payload.attachments] == ["a.png", "b.png", "c.png"]
    assert payload.body == "@agent-a captioned"
    assert await _pending(session_factory) == []


async def test_a_group_is_kept_as_the_one_message_it_was_posted_as(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    """Each part is a row of its own in the room's log, and the conversation
    read from there leaves out a row whose message the agent already has, by
    the id the message is known by: for a part, its group's. So the group is
    kept under the group's id, at the part furthest on in the room. Kept under
    one part's id, the other parts would reach the agent again as
    conversation."""
    for index in [0, 2, 1]:
        await scene.part(
            index,
            3,
            "grp-key",
            f"f{index}.png",
            caption="@agent-a three" if index == 0 else None,
        )

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        furthest = await session.scalar(
            select(Message.seq)
            .where(Message.room_id == scene.room.id)
            .order_by(Message.seq.desc())
            .limit(1)
        )
        kept = (
            await session.execute(
                select(AgentEventRow.room_seq, AgentEventRow.message_key).where(
                    AgentEventRow.agent_id == scene.agent.id
                )
            )
        ).all()
    assert [tuple(row) for row in kept] == [(furthest, "grp-key")]


async def test_ungrouped_media_emits_immediately(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    await scene.process.send_file(
        scene.room, "cat.png", sender=scene.alice, caption="@agent-a a cat"
    )

    events = await _events(session_factory, scene)
    assert len(events) == 1
    payload = _payload(events[0])
    assert [a.filename for a in payload.attachments] == ["cat.png"]
    assert payload.body == "@agent-a a cat"
    assert await _pending(session_factory) == []


async def test_incomplete_group_flushes_with_disclosed_notice(
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
    long_wait: None,
) -> None:
    for index, name in [(0, "cat.png"), (1, "notes.md")]:
        await scene.part(
            index,
            3,
            "grp-3",
            name,
            caption="@agent-a two of three" if index == 0 else None,
        )
    assert await _events(session_factory, scene) == []

    await _after_the_wait(scene)

    events = await _events(session_factory, scene)
    assert len(events) == 1
    payload = _payload(events[0])
    assert [a.filename for a in payload.attachments] == ["cat.png", "notes.md"]
    assert "two of three" in payload.body
    assert "incomplete attachment group: 2 of 3" in payload.body
    # No leak: the pending post is gone once decided.
    assert await _pending(session_factory) == []


async def test_an_agent_that_joins_while_a_post_waits_is_not_given_it(
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
    long_wait: None,
) -> None:
    """A member counts from when it joined: one that arrives after a post's
    first file was written was never handed that file, so the post decided
    without the rest does not reach it either."""
    await scene.part(0, 2, "grp-late-member", "one.png", caption="@agent-a @late both")
    late, late_client = await make_agent(session_factory, "late")
    await add_member(session_factory, scene.room, late_client, agent=late)

    await _after_the_wait(scene)

    assert len(await _events(session_factory, scene)) == 1
    assert await own_events(session_factory, late.id) == []


async def test_group_is_anchored_on_part_zero_not_the_completing_part(
    session_factory: async_sessionmaker[AsyncSession], scene: _Scene
) -> None:
    """The coalesced message must carry part 0's event id, so a reply threads
    off the canonical first event rather than whichever part landed last."""
    # Part 0 arrives FIRST, so a later part completes the group; otherwise the
    # completing event happens to be part 0 and the assertion proves nothing.
    ids = [
        await scene.part(
            index,
            3,
            "grp-anchor",
            name,
            caption="@agent-a three" if index == 0 else None,
        )
        for index, name in [(0, "a.png"), (1, "b.md"), (2, "c.csv")]
    ]

    events = await _events(session_factory, scene)
    assert len(events) == 1
    # Part 2 completed the group, but part 0 anchors the payload.
    assert _payload(events[0]).message_id == ids[0]


async def test_incomplete_group_is_anchored_on_part_zero(
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
    long_wait: None,
) -> None:
    first = await scene.part(0, 3, "grp-anchor-2", "a.png", caption="@agent-a anchored")
    await scene.part(2, 3, "grp-anchor-2", "c.csv")

    await _after_the_wait(scene)

    events = await _events(session_factory, scene)
    assert len(events) == 1
    assert _payload(events[0]).message_id == first


async def test_group_timeout_bounds_the_group_not_the_gap_between_parts(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
) -> None:
    """The wait is armed once per group. A batch dribbling in just under the
    timeout must not be able to hold the post back indefinitely.

    The deadline is read rather than waited on: the post's first file sets
    it, from the database's clock, and the files after it leave it where it
    is. Only one timer is set, for the deadline the first file set.
    """
    armed: list[float] = []
    real = scene.process.router.flush_groups_after

    def flush_groups_after(tenant_id: str, delay: float) -> None:
        armed.append(delay)

    monkeypatch.setattr(scene.process.router, "flush_groups_after", flush_groups_after)
    await scene.part(0, 4, "grp-slow", "a.png", caption="@agent-a slow batch")
    [pending] = await _pending(session_factory)
    deadline = pending.deadline
    assert len(armed) == 1
    assert 0 < armed[0] <= router_module.ATTACHMENT_GROUP_TIMEOUT_SECONDS

    # Parts keep trickling in below the deadline; it must NOT be pushed back
    # by each arrival.
    for index, name in [(1, "b.md"), (2, "c.csv")]:
        await scene.part(index, 4, "grp-slow", name)
        [pending] = await _pending(session_factory)
        assert pending.deadline == deadline
        assert len(armed) == 1

    # The deadline passes.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(
            update(PendingAttachmentGroup).values(
                deadline=PendingAttachmentGroup.deadline - timedelta(seconds=10)
            )
        )
        await session.commit()
    monkeypatch.setattr(scene.process.router, "flush_groups_after", real)
    assert await scene.process.router.flush_due_groups(TENANT_ZERO_ID) == 1
    await scene.process.idle()

    # Decided on the group's own deadline rather than being extended forever.
    events = await _events(session_factory, scene)
    assert len(events) == 1
    assert "incomplete attachment group: 3 of 4" in _payload(events[0]).body
    assert await _pending(session_factory) == []


async def test_the_timer_decides_a_post_whose_wait_is_over(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
) -> None:
    """The timer the first file arms decides the post on its own, with no
    sweep run for it. One file only, so there is no later file for a short
    timer to race; the wait for it is polled, with room for a busy machine."""
    monkeypatch.setattr(router_module, "ATTACHMENT_GROUP_TIMEOUT_SECONDS", 0.01)
    await scene.part(0, 2, "grp-timer", "one.png", caption="@agent-a one of two")

    async with asyncio.timeout(10):
        while await _pending(session_factory):
            await asyncio.sleep(0.01)
    await scene.process.idle()

    events = await _events(session_factory, scene)
    assert len(events) == 1
    assert "incomplete attachment group: 1 of 2" in _payload(events[0]).body


class TestAddressingSurvivesCoalescing:
    """Two screenshots in one Slack message reached nobody (CHOO-2173).

    One such message is split: the text and its `@mention` ride on part 0 and
    every later part is a bare file. Addressing was read from whichever part
    completed the group (a filename), so the reassembled message claimed to
    address nobody and each agent, correctly, ignored it.
    """

    async def test_a_mention_on_part_zero_addresses_the_whole_group(
        self, session_factory: async_sessionmaker[AsyncSession], scene: _Scene
    ) -> None:
        for index, name in [(0, "one.png"), (1, "two.png")]:
            await scene.part(
                index,
                2,
                "grp-addr",
                name,
                caption="@agent-a look at these" if index == 0 else None,
            )

        events = await _events(session_factory, scene)
        assert len(events) == 1
        payload = _payload(events[0])
        assert payload.addressed is True
        # The text travels with the images rather than being left on the part
        # it arrived on.
        assert payload.body == "@agent-a look at these"
        assert [a.filename for a in payload.attachments] == ["one.png", "two.png"]

    async def test_it_holds_when_the_captioned_part_arrives_last(
        self, session_factory: async_sessionmaker[AsyncSession], scene: _Scene
    ) -> None:
        for index, name in [(1, "two.png"), (0, "one.png")]:
            await scene.part(
                index,
                2,
                "grp-addr-rev",
                name,
                caption="@agent-a look at these" if index == 0 else None,
            )

        assert _payload((await _events(session_factory, scene))[0]).addressed is True

    async def test_a_group_that_mentions_nobody_stays_unaddressed(
        self, session_factory: async_sessionmaker[AsyncSession], scene: _Scene
    ) -> None:
        # The fix must carry addressing across the group, not assert it. A
        # group for nobody is the room's conversation, so nothing is stored for
        # the agent: it is read from the room's log by a reader that wants it.
        for index, name in [(0, "one.png"), (1, "two.png")]:
            await scene.part(
                index,
                2,
                "grp-unaddr",
                name,
                caption="just some pictures" if index == 0 else None,
            )

        assert await _events(session_factory, scene) == []
        assert await _pending(session_factory) == []

    async def test_an_incomplete_group_is_still_addressed(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        scene: _Scene,
        long_wait: None,
    ) -> None:
        # A batch that never completes is decided by the safety net, and
        # losing a file is no reason to also lose who it was for.
        await scene.part(
            0, 3, "grp-addr-partial", "one.png", caption="@agent-a two of three"
        )
        await scene.part(1, 3, "grp-addr-partial", "two.png")
        await _after_the_wait(scene)

        events = await _events(session_factory, scene)
        assert len(events) == 1
        payload = _payload(events[0])
        assert payload.addressed is True
        assert "@agent-a two of three" in payload.body

    async def test_a_single_attachment_is_unaffected(
        self, session_factory: async_sessionmaker[AsyncSession], scene: _Scene
    ) -> None:
        # One screenshot always worked; it takes no group and no waiting.
        await scene.process.send_file(
            scene.room, "one.png", sender=scene.alice, caption="@agent-a one picture"
        )

        assert _payload((await _events(session_factory, scene))[0]).addressed is True


async def test_a_grouped_post_addressed_to_the_agent_is_reported_once(
    scene: _Scene,
) -> None:
    """Three files in one post are one message asked of the agent, not three:
    the report follows the coalesced payload, not the parts."""
    for index in range(3):
        await scene.part(
            index,
            3,
            "grp-r",
            f"f{index}.png",
            caption="@agent-a look at these" if index == 0 else None,
        )
    await scene.process.idle()

    assert scene.process.telemetry.addressed == [
        {
            "tenant_id": TENANT_ZERO_ID,
            "room_id": scene.room.id,
            "sender_transport_user_id": scene.alice.transport_user_id,
            "from_platform": False,
            "agent_metadata": None,
            "agent_live": True,
            "has_attachment": True,
        }
    ]


@pytest.mark.parametrize("late_index", [0, 2])
async def test_a_post_split_by_the_timeout_is_reported_once(
    late_index: int,
    session_factory: async_sessionmaker[AsyncSession],
    long_wait: None,
) -> None:
    """A group that times out incomplete is delivered again when the rest
    arrives. In a direct room both pieces address the agent, but it is one
    post: counted with its first part, as the transport counts it."""
    scene = await _scene(session_factory, channel_type="direct")
    on_time = [index for index in range(3) if index != late_index]
    for batch in (on_time, [late_index]):
        for index in batch:
            await scene.part(index, 3, "grp-late", f"f{index}.png")
        await _after_the_wait(scene)

    assert len(await _events(session_factory, scene)) == 2
    assert len(scene.process.telemetry.addressed) == 1


async def test_media_skips_the_availability_check_while_telemetry_is_off(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
    scene: _Scene,
) -> None:
    """The media path reads it only to report it, so off means no query."""
    checks = _count_calls(monkeypatch, "_is_available")
    scene.process.telemetry.enabled = False

    await scene.process.send_file(
        scene.room, "a.png", sender=scene.alice, caption="@agent-a look"
    )
    await scene.process.idle()

    assert checks == []
    assert len(await _events(session_factory, scene)) == 1


async def test_media_that_does_not_address_the_agent_is_not_reported(
    scene: _Scene,
) -> None:
    await scene.process.send_file(
        scene.room, "a.png", sender=scene.alice, caption="just a picture"
    )
    await scene.process.idle()

    assert scene.process.telemetry.addressed == []


def _count_calls(monkeypatch: pytest.MonkeyPatch, name: str) -> list[object]:
    calls: list[object] = []
    real: Callable[..., Any] = getattr(AgentRecipient, name)

    async def counting(self: AgentRecipient, *args: Any, **kwargs: Any) -> Any:
        calls.append(args)
        return await real(self, *args, **kwargs)

    monkeypatch.setattr(AgentRecipient, name, counting)
    return calls
