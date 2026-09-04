from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import switch_core.clients.agent_client as ac
from switch_core.clients.agent_client import AgentClient, _GateOutcome
from switch_core.clients.room_meta import RoomMeta
from switch_core.transport import InboundMedia, RoomRef


def _media_event(
    *,
    body: str,
    filename: str | None = None,
    mimetype: str = "image/png",
    msgtype: str = "m.image",
    group: dict[str, Any] | None = None,
    event_id: str = "$evt",
) -> InboundMedia:
    content: dict[str, Any] = {
        "msgtype": msgtype,
        "body": body,
        "url": "mxc://s/abc",
        "info": {"mimetype": mimetype, "size": 5},
        "sender_name": "alice",
    }
    if filename is not None:
        content["filename"] = filename
    if group is not None:
        content["com.switch.attachment_group"] = group
    return InboundMedia(
        room_id="!room:s",
        event_id=event_id,
        sender="@alice:s",
        timestamp=1700000000000,
        content=content,
        body=body,
        sender_name="alice",
        msgtype=msgtype,
        uri="mxc://s/abc",
        filename=filename,
        mimetype=mimetype,
        size=5,
        group=group,
    )


@asynccontextmanager
async def _session_factory():  # type: ignore[no-untyped-def]
    yield object()


class _FakeQueue:
    def __init__(self) -> None:
        self.events: list[Any] = []

    def enqueue(self, _agent_id: str, _room_id: str, event: Any) -> None:
        self.events.append(event)


def _fake_client() -> SimpleNamespace:
    queue = _FakeQueue()
    meta = RoomMeta(room_id="room-1", name="Room", bridge_id="bridge-1")

    async def _resolve_room_meta(_matrix_room_id: str) -> RoomMeta:
        return meta

    async def _addressed(event: Any, _meta: RoomMeta) -> bool:
        # Mirrors production, where addressing is read off the message text.
        # Standing in a constant `True` here is what let the coalescing bug
        # through: every part looked addressed, including the caption-less ones
        # that in reality address nobody.
        return f"@{ns.agent.name}" in getattr(event, "body", "")

    async def _fresh_agent(_session: Any) -> Any:
        return ns.agent

    async def _gate_addressed(
        _session: Any, _agent: Any, _event: Any, _meta: Any
    ) -> _GateOutcome:
        return _GateOutcome(addressed=True, refusal=None)

    ns = SimpleNamespace(
        agent=SimpleNamespace(id="agent-1", name="agent-a"),
        session_factory=_session_factory,
        _event_buffer=queue,
        _attachment_groups={},
        _attachment_group_timers={},
        _resolve_room_meta=_resolve_room_meta,
        _addressed=_addressed,
        _fresh_agent=_fresh_agent,
        _gate_addressed=_gate_addressed,
        queue=queue,
    )
    ns._emit_media = AgentClient._emit_media.__get__(ns)
    ns._schedule_attachment_group_flush = (
        AgentClient._schedule_attachment_group_flush.__get__(ns)
    )
    ns._cancel_attachment_group_flush = (
        AgentClient._cancel_attachment_group_flush.__get__(ns)
    )
    ns._flush_incomplete_attachment_group = (
        AgentClient._flush_incomplete_attachment_group.__get__(ns)
    )
    return ns


def _room() -> RoomRef:
    return RoomRef(room_id="!room:s")


async def test_grouped_media_coalesces_into_one_event() -> None:
    client = _fake_client()
    parts = [
        ("cat.png", "image/png", "m.image"),
        ("notes.md", "text/markdown", "m.file"),
        ("data.csv", "text/csv", "m.file"),
    ]

    for index, (name, mimetype, msgtype) in enumerate(parts):
        await AgentClient.on_media(
            client,
            _room(),
            _media_event(
                body="three files" if index == 0 else name,
                filename=name if index == 0 else None,
                mimetype=mimetype,
                msgtype=msgtype,
                event_id=f"$part-{index}",
                group={"id": "grp-1", "index": index, "total": 3},
            ),
        )
        if index < 2:
            assert client.queue.events == []

    assert len(client.queue.events) == 1
    payload = client.queue.events[0].payload
    assert [a.filename for a in payload.attachments] == [
        "cat.png",
        "notes.md",
        "data.csv",
    ]
    assert payload.body == "three files"
    assert client._attachment_groups == {}
    assert client._attachment_group_timers == {}


async def test_grouped_media_coalesces_out_of_order() -> None:
    client = _fake_client()
    order = [1, 0, 2]
    names = {0: "a.png", 1: "b.png", 2: "c.png"}

    for index in order:
        await AgentClient.on_media(
            client,
            _room(),
            _media_event(
                body="captioned" if index == 0 else names[index],
                filename=names[index] if index == 0 else None,
                event_id=f"$part-{index}",
                group={"id": "grp-2", "index": index, "total": 3},
            ),
        )

    assert len(client.queue.events) == 1
    payload = client.queue.events[0].payload
    # Sorted by group index, not arrival order.
    assert [a.filename for a in payload.attachments] == ["a.png", "b.png", "c.png"]
    assert payload.body == "captioned"
    assert client._attachment_groups == {}
    assert client._attachment_group_timers == {}


async def test_ungrouped_media_emits_immediately() -> None:
    client = _fake_client()

    await AgentClient.on_media(
        client, _room(), _media_event(body="cat.png", mimetype="image/png")
    )

    assert len(client.queue.events) == 1
    payload = client.queue.events[0].payload
    assert [a.filename for a in payload.attachments] == ["cat.png"]
    assert payload.body == "cat.png"
    assert client._attachment_groups == {}
    assert client._attachment_group_timers == {}


async def test_incomplete_group_flushes_with_disclosed_notice() -> None:
    original = ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS
    ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = 0.01
    try:
        client = _fake_client()
        for index, name in [(0, "cat.png"), (1, "notes.md")]:
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="two of three" if index == 0 else name,
                    filename=name if index == 0 else None,
                    event_id=f"$part-{index}",
                    group={"id": "grp-3", "index": index, "total": 3},
                ),
            )
        assert client.queue.events == []

        await asyncio.sleep(0.15)
    finally:
        ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = original

    assert len(client.queue.events) == 1
    payload = client.queue.events[0].payload
    assert [a.filename for a in payload.attachments] == ["cat.png", "notes.md"]
    assert "two of three" in payload.body
    assert "incomplete attachment group: 2 of 3" in payload.body
    # No leak: the buffer and its timer are gone once flushed.
    assert client._attachment_groups == {}
    assert client._attachment_group_timers == {}


async def test_group_is_anchored_on_part_zero_not_the_completing_part() -> None:
    """The coalesced message must carry part 0's event id, so a reply threads
    off the canonical first event rather than whichever part landed last."""
    client = _fake_client()
    # Part 0 arrives FIRST, so a later part completes the group — otherwise the
    # completing event happens to be part 0 and the assertion proves nothing.
    for index, name in [(0, "a.png"), (1, "b.md"), (2, "c.csv")]:
        await AgentClient.on_media(
            client,
            _room(),
            _media_event(
                body="three" if index == 0 else name,
                filename=name if index == 0 else None,
                event_id=f"$part-{index}",
                group={"id": "grp-anchor", "index": index, "total": 3},
            ),
        )

    assert len(client.queue.events) == 1
    # Part 2 completed the group, but part 0 anchors the payload.
    assert client.queue.events[0].payload.message_id == "$part-0"


async def test_incomplete_group_is_anchored_on_part_zero() -> None:
    original = ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS
    ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = 0.01
    try:
        client = _fake_client()
        for index, name in [(0, "a.png"), (2, "c.csv")]:
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="anchored" if index == 0 else name,
                    filename=name if index == 0 else None,
                    event_id=f"$part-{index}",
                    group={"id": "grp-anchor-2", "index": index, "total": 3},
                ),
            )
        await asyncio.sleep(0.15)
    finally:
        ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = original

    assert len(client.queue.events) == 1
    assert client.queue.events[0].payload.message_id == "$part-0"


async def test_group_timeout_bounds_the_group_not_the_gap_between_parts() -> None:
    """The safety-net timer is armed once per group. A batch dribbling in just
    under the timeout must not be able to hold the buffer open indefinitely."""
    original = ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS
    ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = 0.12
    try:
        client = _fake_client()
        await AgentClient.on_media(
            client,
            _room(),
            _media_event(
                body="slow batch",
                filename="a.png",
                event_id="$part-0",
                group={"id": "grp-slow", "index": 0, "total": 4},
            ),
        )
        first_timer = client._attachment_group_timers["grp-slow"]

        # Parts keep trickling in below the deadline; the timer must NOT be
        # pushed back by each arrival.
        for index, name in [(1, "b.md"), (2, "c.csv")]:
            await asyncio.sleep(0.05)
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body=name,
                    event_id=f"$part-{index}",
                    group={"id": "grp-slow", "index": index, "total": 4},
                ),
            )
            assert client._attachment_group_timers["grp-slow"] is first_timer

        await asyncio.sleep(0.15)
    finally:
        ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = original

    # Fired on the group's own deadline rather than being extended forever.
    assert len(client.queue.events) == 1
    payload = client.queue.events[0].payload
    assert "incomplete attachment group: 3 of 4" in payload.body
    assert client._attachment_groups == {}
    assert client._attachment_group_timers == {}


class TestAddressingSurvivesCoalescing:
    """Two screenshots in one Slack message reached nobody (CHOO-2173).

    Matrix has no multi-attachment event, so one such message is split: the
    text and its `@mention` ride on part 0 and every later part is a bare
    file. Addressing was read from whichever part completed the group — a
    filename — so the reassembled message claimed to address nobody and each
    consumer, correctly, ignored it.
    """

    async def test_a_mention_on_part_zero_addresses_the_whole_group(self) -> None:
        client = _fake_client()
        for index, name in [(0, "one.png"), (1, "two.png")]:
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="@agent-a look at these" if index == 0 else name,
                    filename=name if index == 0 else None,
                    event_id=f"$part-{index}",
                    group={"id": "grp-addr", "index": index, "total": 2},
                ),
            )

        assert len(client.queue.events) == 1
        payload = client.queue.events[0].payload
        assert payload.addressed is True
        # The text travels with the images rather than being left on the part
        # it arrived on.
        assert payload.body == "@agent-a look at these"
        assert [a.filename for a in payload.attachments] == ["one.png", "two.png"]

    async def test_it_holds_when_the_captioned_part_arrives_last(self) -> None:
        client = _fake_client()
        for index, name in [(1, "two.png"), (0, "one.png")]:
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="@agent-a look at these" if index == 0 else name,
                    filename=name if index == 0 else None,
                    event_id=f"$part-{index}",
                    group={"id": "grp-addr-rev", "index": index, "total": 2},
                ),
            )

        assert client.queue.events[0].payload.addressed is True

    async def test_a_group_that_mentions_nobody_stays_unaddressed(self) -> None:
        # The fix must carry addressing across the group, not assert it.
        client = _fake_client()
        for index, name in [(0, "one.png"), (1, "two.png")]:
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="just some pictures" if index == 0 else name,
                    filename=name if index == 0 else None,
                    event_id=f"$part-{index}",
                    group={"id": "grp-unaddr", "index": index, "total": 2},
                ),
            )

        assert client.queue.events[0].payload.addressed is False

    async def test_an_incomplete_group_is_still_addressed(self) -> None:
        # A batch that never completes is delivered by the safety net, and
        # losing a file is no reason to also lose who it was for.
        original = ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS
        ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = 0.01
        try:
            client = _fake_client()
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="@agent-a two of three",
                    filename="one.png",
                    event_id="$part-0",
                    group={"id": "grp-addr-partial", "index": 0, "total": 3},
                ),
            )
            await AgentClient.on_media(
                client,
                _room(),
                _media_event(
                    body="two.png",
                    event_id="$part-1",
                    group={"id": "grp-addr-partial", "index": 1, "total": 3},
                ),
            )
            await asyncio.sleep(0.15)
        finally:
            ac.ATTACHMENT_GROUP_TIMEOUT_SECONDS = original

        assert len(client.queue.events) == 1
        payload = client.queue.events[0].payload
        assert payload.addressed is True
        assert "@agent-a two of three" in payload.body

    async def test_a_single_attachment_is_unaffected(self) -> None:
        # One screenshot always worked; it takes no group and no buffering.
        client = _fake_client()
        await AgentClient.on_media(
            client, _room(), _media_event(body="@agent-a one picture")
        )

        assert client.queue.events[0].payload.addressed is True
