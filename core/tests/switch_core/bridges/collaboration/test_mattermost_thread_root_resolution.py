"""Tests for resolving thread root in Mattermost adapter (#1709).

Mattermost requires root_id to be the thread's root post id; passing a
reply post's id fails with 'Invalid RootId parameter'.
When an approval card is posted inside a thread (as a reply to an owner's command)
and a typed answer refusal notice or notification is posted, the thread_ref
passed is the card's reply id. The adapter must resolve this reply id to the
thread's true root_id.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)


class _MockPosts:
    def __init__(self) -> None:
        self.posts_store: dict[str, dict[str, Any]] = {}
        self.created: list[dict[str, Any]] = []
        self.ephemeral_created: list[dict[str, Any]] = []

    def get_post(self, post_id: str) -> dict[str, Any]:
        if post_id in self.posts_store:
            return self.posts_store[post_id]
        if post_id == "error-post":
            raise RuntimeError("Mattermost API connection error")
        # Default root post
        return {"id": post_id, "root_id": ""}

    def create_post(self, post: dict[str, Any]) -> dict[str, Any]:
        self.created.append(post)
        return {"id": f"new-{len(self.created)}"}

    def create_ephemeral_post(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.ephemeral_created.append(payload)
        return {"id": f"ephemeral-{len(self.ephemeral_created)}"}


def _setup_adapter() -> tuple[MattermostAdapter, _MockPosts, asyncio.AbstractEventLoop]:
    loop = asyncio.new_event_loop()
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    posts = _MockPosts()
    driver = type("_Driver", (), {"posts": posts})()
    adapter._admin_driver = driver  # type: ignore[assignment]
    adapter._main_loop = loop
    return adapter, posts, loop


def test_post_under_thread_root_keeps_root_id() -> None:
    adapter, posts, loop = _setup_adapter()
    posts.posts_store["root-1"] = {"id": "root-1", "root_id": ""}

    try:
        res = loop.run_until_complete(
            adapter._create_post(
                adapter._admin_driver,  # type: ignore[arg-type]
                "channel-1",
                "hello in thread",
                "root-1",
            )
        )
        assert res == "new-1"
        assert len(posts.created) == 1
        assert posts.created[0]["root_id"] == "root-1"
    finally:
        loop.close()


def test_post_under_reply_resolves_to_parent_root() -> None:
    adapter, posts, loop = _setup_adapter()
    # "card-reply-2" is posted inside thread under "thread-root-100"
    posts.posts_store["card-reply-2"] = {
        "id": "card-reply-2",
        "root_id": "thread-root-100",
        "message": "approval card",
    }

    try:
        # Refusal notice or follow-up sent with thread_root_id="card-reply-2"
        res = loop.run_until_complete(
            adapter._create_post(
                adapter._admin_driver,  # type: ignore[arg-type]
                "channel-1",
                "Answer refused: not authorized",
                "card-reply-2",
            )
        )
        assert res == "new-1"
        assert len(posts.created) == 1
        # Must resolve to thread-root-100, NOT card-reply-2!
        assert posts.created[0]["root_id"] == "thread-root-100"
    finally:
        loop.close()


def test_notify_privately_resolves_reply_to_parent_root() -> None:
    adapter, posts, loop = _setup_adapter()
    posts.posts_store["reply-card-5"] = {
        "id": "reply-card-5",
        "root_id": "root-999",
        "message": "card",
    }

    try:
        loop.run_until_complete(
            adapter.notify_privately(
                channel_id="channel-1",
                channel_name="general",
                user_id="user-1",
                content="Private warning",
                thread_root_id="reply-card-5",
            )
        )
        assert len(posts.ephemeral_created) == 1
        ephemeral_post = posts.ephemeral_created[0]["post"]
        # Must resolve to root-999
        assert ephemeral_post["root_id"] == "root-999"
    finally:
        loop.close()


def test_resolve_thread_root_falls_back_on_api_error() -> None:
    adapter, posts, loop = _setup_adapter()

    try:
        # "error-post" triggers RuntimeError in get_post
        res = loop.run_until_complete(
            adapter._create_post(
                adapter._admin_driver,  # type: ignore[arg-type]
                "channel-1",
                "fallback message",
                "error-post",
            )
        )
        assert res == "new-1"
        assert len(posts.created) == 1
        # Safely falls back to the original without crashing
        assert posts.created[0]["root_id"] == "error-post"
    finally:
        loop.close()
