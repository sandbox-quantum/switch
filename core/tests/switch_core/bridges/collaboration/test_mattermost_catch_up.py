"""Posts sent while a bot's socket was closed are fetched when it reopens.

Mattermost hands a post only to the sockets open when it is sent. A post sent
while every bot's socket in its channel was closed (a dropped connection being
reopened) never arrived, and nothing went back for it. Each reopen now fetches,
per channel, the posts sent since the newest one heard, and hands in those no
copy of was, through the same claim as a post heard live.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessage


def _post(post_id: str, created: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": post_id,
        "user_id": "user-alice",
        "channel_id": "chan-1",
        "message": f"message {post_id}",
        "type": "",
        "root_id": "",
        "create_at": created,
        **extra,
    }


def _posted(post: dict[str, Any]) -> str:
    return json.dumps(
        {"event": "posted", "data": {"post": json.dumps(post), "channel_type": "O"}}
    )


_HELLO = json.dumps({"event": "hello", "data": {"server_version": "10"}, "seq": 0})


class _Posts:
    """The channel's posts as Mattermost lists them: newest first, a page at a time."""

    def __init__(self, posts: list[dict[str, Any]], *, fail: bool = False) -> None:
        self._posts = posts
        self._fail = fail
        self.asked: list[tuple[str, int]] = []

    def get_posts_for_channel(
        self, channel_id: str, params: dict[str, int]
    ) -> dict[str, Any]:
        self.asked.append((channel_id, params["page"]))
        if self._fail:
            raise ConnectionError("Mattermost was not reachable")
        newest = sorted(self._posts, key=lambda p: -p["create_at"])
        start = params["page"] * params["per_page"]
        chunk = newest[start : start + params["per_page"]]
        return {"order": [p["id"] for p in chunk], "posts": {p["id"]: p for p in chunk}}


def _adapter(posts: _Posts) -> MattermostAdapter:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mattermost.invalid",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    adapter._admin_driver = SimpleNamespace(  # type: ignore[assignment]
        users=SimpleNamespace(get_user=lambda user_id: {"username": "alice"}),
        posts=posts,
        channels=SimpleNamespace(
            get_channel=lambda channel_id: {"type": "O", "display_name": "Team"}
        ),
    )
    adapter._admin_user_id = "admin-user"
    return adapter


class _Socket:
    """One bot's socket: its own thread and event loop, as the adapter runs it."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self._thread.start()

    async def deliver(self, adapter: MattermostAdapter, event: str, bot: str) -> None:
        await asyncio.wrap_future(
            asyncio.run_coroutine_threadsafe(adapter._ws_handler(event, bot), self.loop)
        )

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)
        self.loop.close()


async def _until(check: Callable[[], bool], seconds: float = 5) -> None:
    async with asyncio.timeout(seconds):
        while not check():
            await asyncio.sleep(0.01)


async def _settle() -> None:
    await asyncio.sleep(0.2)


def _handed(adapter: MattermostAdapter) -> list[InboundMessage]:
    handed: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        handed.append(msg)

    adapter._on_message = on_message
    return handed


class TestCatchUp:
    async def test_posts_sent_while_every_socket_was_down_arrive_once_after_the_reopen(
        self,
    ) -> None:
        heard_live = _post("post-1", 1_000)
        missed = [_post("post-2", 2_000), _post("post-3", 3_000)]
        posts = _Posts([heard_live, *missed])
        adapter = _adapter(posts)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            await socket.deliver(adapter, _posted(heard_live), "bot-a")
            await _until(lambda: len(handed) >= 1)
            # Every socket was closed while post-2 and post-3 were sent; one reopens.
            await socket.deliver(adapter, _HELLO, "bot-a")
            await _until(lambda: len(handed) >= 3)
            # A late live copy, and a second reopen, change nothing.
            await socket.deliver(adapter, _posted(missed[1]), "bot-b")
            await socket.deliver(adapter, _HELLO, "bot-b")
            await _settle()
        finally:
            socket.close()

        assert [m.message_ref for m in handed] == ["post-1", "post-2", "post-3"]
        assert handed[1].channel_name == "Team"
        assert posts.asked[0] == ("chan-1", 0)

    async def test_an_edited_older_post_or_a_deleted_one_is_not_handed_in(self) -> None:
        heard_live = _post("post-1", 1_000)
        edited_before = _post("post-0", 500, update_at=2_500)
        deleted = _post("post-4", 2_000, delete_at=2_100)
        posts = _Posts([edited_before, heard_live, deleted])
        adapter = _adapter(posts)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            await socket.deliver(adapter, _posted(heard_live), "bot-a")
            await _until(lambda: len(handed) >= 1)
            await socket.deliver(adapter, _HELLO, "bot-a")
            await _until(lambda: len(posts.asked) >= 1)
            await _settle()
        finally:
            socket.close()

        assert [m.message_ref for m in handed] == ["post-1"]

    async def test_a_reopen_before_any_post_was_heard_fetches_nothing(self) -> None:
        posts = _Posts([_post("post-1", 1_000)])
        adapter = _adapter(posts)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            await socket.deliver(adapter, _HELLO, "bot-a")
            await _settle()
        finally:
            socket.close()

        assert handed == []
        assert posts.asked == []

    async def test_a_fetch_that_fails_is_said(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        heard_live = _post("post-1", 1_000)
        posts = _Posts([heard_live], fail=True)
        adapter = _adapter(posts)
        adapter._main_loop = asyncio.get_running_loop()
        handed = _handed(adapter)
        socket = _Socket()
        try:
            with caplog.at_level(logging.WARNING):
                await socket.deliver(adapter, _posted(heard_live), "bot-a")
                await _until(lambda: len(handed) >= 1)
                await socket.deliver(adapter, _HELLO, "bot-a")
                await _until(lambda: len(posts.asked) >= 1)
                await _settle()
        finally:
            socket.close()

        assert [m.message_ref for m in handed] == ["post-1"]
        assert "Could not fetch the posts Mattermost channel chan-1 had" in caplog.text
        # Still marked: the next reopen or drain tries again.
        assert adapter._catch_up_from == {"chan-1": 1_000}
        assert "ConnectionError" in caplog.text
