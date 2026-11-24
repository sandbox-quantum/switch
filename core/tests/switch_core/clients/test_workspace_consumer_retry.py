"""A room message that did not reach the platform is held and tried again by
the bridge's workspace consumer, and left to the next holder once it stops."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.clients import workspace_consumer
from switch_core.clients.workspace_consumer import WorkspaceConsumer
from switch_core.transport import InboundMessage, RoomRef

ROOM = RoomRef(room_id="!room:test")


def _message(seq: int) -> InboundMessage:
    return InboundMessage(
        room_id=ROOM.room_id,
        event_id=f"ev{seq}",
        sender="@someone:test",
        timestamp=0,
        seq=seq,
        body="hello",
    )


def _consumer(relay: Any, *, running: bool) -> tuple[WorkspaceConsumer, MagicMock]:
    core = MagicMock()
    core.bridge_type = "chat"
    core.held_from.return_value = None
    core.handle_outbound_message = relay
    actor = MagicMock()
    consumer = WorkspaceConsumer(actor=actor, collaboration_core=core)
    consumer._running = running
    return consumer, actor.transport


@pytest.fixture(autouse=True)
def quick_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (0.01, 0.01))


async def test_a_failed_message_is_held_until_a_retry_posts_it() -> None:
    relay = AsyncMock(side_effect=[RuntimeError("refused"), None])
    consumer, transport = _consumer(relay, running=True)

    await consumer.on_message(ROOM, _message(7))
    assert consumer.held_from(ROOM.room_id) == 7

    async with asyncio.timeout(2):
        while consumer.held_from(ROOM.room_id) is not None:
            await asyncio.sleep(0.005)
    assert relay.await_count == 2
    transport.held_back_released.assert_called_once_with(ROOM.room_id)


async def test_a_message_failing_every_retry_is_given_up_on() -> None:
    relay = AsyncMock(side_effect=RuntimeError("refused"))
    consumer, transport = _consumer(relay, running=True)

    await consumer.on_message(ROOM, _message(7))
    async with asyncio.timeout(2):
        while consumer.held_from(ROOM.room_id) is not None:
            await asyncio.sleep(0.005)
    assert relay.await_count == 3
    transport.held_back_released.assert_called_once_with(ROOM.room_id)


async def test_a_message_failing_as_the_bridge_stops_is_left_held() -> None:
    relay = AsyncMock(side_effect=RuntimeError("refused"))
    consumer, transport = _consumer(relay, running=False)

    await consumer.on_message(ROOM, _message(7))
    await asyncio.sleep(0.05)

    assert consumer.held_from(ROOM.room_id) == 7
    assert relay.await_count == 1
    assert not consumer._retries
    transport.held_back_released.assert_not_called()


async def test_a_retry_cancelled_by_teardown_leaves_the_message_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(workspace_consumer, "RETRY_RELAY_AFTER_SECONDS", (60.0,))
    relay = AsyncMock(side_effect=RuntimeError("refused"))
    consumer, transport = _consumer(relay, running=True)

    await consumer.on_message(ROOM, _message(7))
    await consumer.teardown()

    assert consumer.held_from(ROOM.room_id) == 7
    assert relay.await_count == 1
    transport.held_back_released.assert_not_called()
