"""A room row that did not reach the platform is held, with every later row
of its room, and tried again by the bridge's workspace consumer; once it
stops, held rows are left to the next holder."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from switch_core.clients import workspace_consumer
from switch_core.clients.workspace_consumer import RelayFailed, WorkspaceConsumer
from switch_core.transport import InboundMessage, RoomRef

ROOM = RoomRef(room_id="!room:test")


class Refused(Exception):
    pass


class RefusedForGood(Exception):
    pass


class Platform:
    """What the bridge posted, in order, refusing the next few tries of the
    rows it is told to."""

    def __init__(self) -> None:
        self.posted: list[int] = []
        self.tries: list[int] = []
        self.refusing: dict[int, int] = {}
        self.for_good: set[int] = set()

    async def post(self, seq: int) -> None:
        self.tries.append(seq)
        if seq in self.for_good:
            raise RefusedForGood(seq)
        if self.refusing.get(seq, 0) > 0:
            self.refusing[seq] -= 1
            raise Refused(seq)
        self.posted.append(seq)


def _message(seq: int) -> InboundMessage:
    return InboundMessage(
        room_id=ROOM.room_id,
        event_id=f"ev{seq}",
        sender="@someone:test",
        timestamp=0,
        seq=seq,
        body="hello",
    )


def _consumer(
    platform: Platform, *, running: bool
) -> tuple[WorkspaceConsumer, MagicMock]:
    core = MagicMock()
    core.bridge_type = "chat"
    core.held_from.return_value = None
    core.refusal_kind.side_effect = lambda error: (
        "permanent" if isinstance(error, RefusedForGood) else "transient"
    )

    async def relay(room: RoomRef, event: InboundMessage) -> None:
        await platform.post(event.seq)

    core.handle_outbound_message = relay
    actor = MagicMock()
    consumer = WorkspaceConsumer(actor=actor, collaboration_core=core)
    consumer._running = running
    return consumer, actor.transport


async def _until_nothing_held(consumer: WorkspaceConsumer) -> None:
    async with asyncio.timeout(2):
        while consumer.held_from(ROOM.room_id) is not None:
            await asyncio.sleep(0.005)


@pytest.fixture(autouse=True)
def quick_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (0.01, 0.01))


async def test_a_failed_row_is_held_until_a_retry_posts_it() -> None:
    platform = Platform()
    platform.refusing[7] = 1
    consumer, transport = _consumer(platform, running=True)

    await consumer.on_message(ROOM, _message(7))
    assert consumer.held_from(ROOM.room_id) == 7

    await _until_nothing_held(consumer)
    assert platform.posted == [7]
    transport.held_back_released.assert_called_once_with(ROOM.room_id)


async def test_later_rows_wait_behind_a_failed_one_and_keep_their_order() -> None:
    """A reply posted before the message it answers would be posted outside
    its thread."""
    platform = Platform()
    platform.refusing[5] = 1
    consumer, _ = _consumer(platform, running=True)

    for seq in (5, 6, 7):
        await consumer.on_message(ROOM, _message(seq))
    assert platform.posted == []
    assert consumer.held_from(ROOM.room_id) == 5

    await _until_nothing_held(consumer)
    assert platform.posted == [5, 6, 7]


async def test_a_held_row_delivered_again_is_held_once() -> None:
    """As when the room is read again from its recorded progress."""
    platform = Platform()
    platform.refusing[7] = 1
    consumer, _ = _consumer(platform, running=True)

    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))
    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))

    await _until_nothing_held(consumer)
    assert platform.posted == [7, 8]


async def test_a_row_refused_for_good_is_not_tried_again() -> None:
    platform = Platform()
    platform.for_good.add(7)
    consumer, _ = _consumer(platform, running=True)

    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))

    assert consumer.held_from(ROOM.room_id) is None
    assert platform.tries == [7, 8]
    assert platform.posted == [8]


async def test_a_row_failing_every_retry_is_given_up_and_the_rest_posted() -> None:
    platform = Platform()
    platform.refusing[7] = 99
    consumer, _ = _consumer(platform, running=True)

    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))

    await _until_nothing_held(consumer)
    assert platform.tries == [7, 7, 7, 8]
    assert platform.posted == [8]


async def test_a_failed_multi_file_post_is_held_from_its_first_file() -> None:
    """The last file posts the whole group, so the group's earlier files are
    held with it, and the retry posts the group again."""
    platform = Platform()
    consumer, _ = _consumer(platform, running=True)
    group_posts: list[str] = []

    async def post_the_group() -> None:
        group_posts.append("group")

    async def relay(room: RoomRef, event: InboundMessage) -> None:
        raise RelayFailed(10, post_the_group) from Refused(12)

    consumer._collaboration_core.handle_outbound_message = relay  # type: ignore[attr-defined]

    await consumer.on_message(ROOM, _message(12))
    assert consumer.held_from(ROOM.room_id) == 10

    await _until_nothing_held(consumer)
    assert group_posts == ["group"]


async def test_a_row_failing_as_the_bridge_stops_is_left_held() -> None:
    platform = Platform()
    platform.refusing[7] = 1
    consumer, transport = _consumer(platform, running=False)

    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))
    await asyncio.sleep(0.05)

    assert consumer.held_from(ROOM.room_id) == 7
    assert platform.tries == [7]
    assert not consumer._workers
    transport.held_back_released.assert_not_called()


async def test_held_rows_stopped_by_teardown_stay_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (60.0,))
    platform = Platform()
    platform.refusing[7] = 1
    consumer, transport = _consumer(platform, running=True)

    await consumer.on_message(ROOM, _message(7))
    await consumer.on_message(ROOM, _message(8))
    await consumer.teardown()

    assert consumer.held_from(ROOM.room_id) == 7
    assert platform.tries == [7]
    transport.held_back_released.assert_not_called()
