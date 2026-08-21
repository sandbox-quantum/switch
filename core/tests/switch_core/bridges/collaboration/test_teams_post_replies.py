"""CHOO-2067 — an answer belongs under the question.

A Teams channel is a list of posts, not a stream of messages, so posting at
the channel root starts a new conversation. An agent whose reply named no
thread did exactly that: the question sat in one post and its answer appeared
as a fresh one below, reading as a non-sequitur.
"""

from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.adapter import (
    TeamsAdapter,
    TeamsConnectionConfig,
)

_CHANNEL = "19:abc@thread.tacv2"
_CHAT = "19:meeting_x@unq.gbl.spaces"


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _Connector:
    def __init__(self) -> None:
        self.new_posts: list[str] = []
        self.replies: list[str] = []

    async def create_channel_thread(
        self, *, service_url: str, channel_id: str, activity: dict[str, Any]
    ) -> tuple[str, str]:
        self.new_posts.append(channel_id)
        return f"{channel_id};messageid=new", "msg-new"

    async def send_to_conversation(
        self, *, service_url: str, conversation_id: str, activity: dict[str, Any]
    ) -> str:
        self.replies.append(conversation_id)
        return "msg-reply"


def _adapter() -> tuple[TeamsAdapter, _Connector]:
    adapter = TeamsAdapter(
        config=TeamsConnectionConfig(
            app_id="app-123",
            app_password="secret",
            tenant_id="tenant-9",
            team_id="team-7",
            public_base_url="https://switch.example",
            client_state="s3cr3t",
        )
    )
    connector = _Connector()
    adapter._connector = connector  # type: ignore[assignment]
    adapter._default_service_url = "https://smba.example"
    adapter._channel_type[_CHANNEL] = "channel_public"
    adapter._channel_type[_CHAT] = "group"
    return adapter, connector


async def _seen(adapter: TeamsAdapter, *, root_id: str | None, ref: str) -> None:
    """Put an inbound channel message through the shared delivery path."""
    adapter._on_message = None  # type: ignore[assignment]
    adapter._on_command = None  # type: ignore[assignment]
    await adapter._deliver(
        channel_id=_CHANNEL,
        channel_type="channel_public",
        sender_id="aad-1",
        sender_name="alice",
        text="a question",
        message_ref=ref,
        root_id=root_id,
        channel_name="general",
    )


def test_a_reply_lands_in_the_post_the_question_was_asked_in() -> None:
    adapter, connector = _adapter()
    _run(_seen(adapter, root_id=None, ref="post-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    assert connector.new_posts == []
    assert connector.replies == [f"{_CHANNEL};messageid=post-1"]


def test_a_reply_inside_an_existing_post_uses_that_post_not_the_message() -> None:
    adapter, connector = _adapter()
    _run(_seen(adapter, root_id="post-1", ref="msg-7"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer"))

    assert connector.replies == [f"{_CHANNEL};messageid=post-1"]


def test_an_explicit_thread_still_wins() -> None:
    # A caller that named a thread knows better than the last thing we saw.
    adapter, connector = _adapter()
    _run(_seen(adapter, root_id=None, ref="post-1"))

    _run(adapter.send_message(_CHANNEL, "james", "an answer", "post-9"))

    assert connector.replies == [f"{_CHANNEL};messageid=post-9"]


def test_with_nothing_seen_yet_a_new_post_is_still_opened() -> None:
    # An agent speaking first in a channel has nothing to answer under, and
    # must not be silenced for it.
    adapter, connector = _adapter()

    _run(adapter.send_message(_CHANNEL, "james", "good morning"))

    assert connector.new_posts == [_CHANNEL]
    assert connector.replies == []


def test_group_chats_are_left_alone() -> None:
    # A group chat is a stream, not a list of posts — there is nothing to be
    # wrong about, and forcing a thread would be the wrong shape.
    adapter, connector = _adapter()

    _run(adapter.send_message(_CHAT, "james", "hello"))

    assert connector.new_posts == []
    assert connector.replies == [_CHAT]


def test_the_post_follows_the_conversation_as_it_moves() -> None:
    adapter, connector = _adapter()
    _run(_seen(adapter, root_id=None, ref="post-1"))
    _run(adapter.send_message(_CHANNEL, "james", "first answer"))
    _run(_seen(adapter, root_id=None, ref="post-2"))
    _run(adapter.send_message(_CHANNEL, "james", "second answer"))

    assert connector.replies == [
        f"{_CHANNEL};messageid=post-1",
        f"{_CHANNEL};messageid=post-2",
    ]
