"""A client leaving a live chat feed mid-read lets the read finish.

The web dashboard opens the chat and activity feeds on every page load and
closes them on the next, so a feed is often cancelled while it is reading the
database. Cancelling the read there would close its pooled connection
mid-query, which the pool logs as an error.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.gateway import chats as chats_routes


class _Service:
    """The parts of the chat service the activity feed touches before its first frame."""

    def watch_memberships(self, *_args: Any) -> None:
        pass

    def unwatch_memberships(self, *_args: Any) -> None:
        pass

    async def sync_owned_rooms(self, *_args: Any) -> None:
        pass


async def test_a_feed_cancelled_mid_read_lets_the_read_finish(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    async def slow_read(*_args: Any) -> set[str] | None:
        started.set()
        await release.wait()
        finished.set()
        return None

    monkeypatch.setattr(chats_routes, "_readable_room_ids", slow_read)

    async def still_current() -> bool:
        return True

    stream = chats_routes.chat_activity_events(
        _Service(),  # type: ignore[arg-type]
        "tenant",
        SimpleNamespace(id="user"),  # type: ignore[arg-type]
        ping_seconds=60,
        recheck_seconds=60,
        queue_max=10,
        session_current=still_current,
    )
    consumer = asyncio.create_task(anext(stream, None))
    await started.wait()
    consumer.cancel()
    await asyncio.sleep(0)
    assert not finished.is_set()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await consumer
    assert finished.is_set()
