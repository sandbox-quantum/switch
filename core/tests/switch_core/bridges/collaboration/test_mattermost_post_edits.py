"""Mattermost's `post_edited` is relayed as an edit of the post, once.

Every bot's socket is sent the same event, a post can be edited more than
once, and Mattermost sends the event for things that are not edits (a pin, the
bridge redrawing its own card). Only a change that moved `edit_at` is an edit,
keyed by the post and that stamp; the bridge's own posts are never relayed.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessage

_AUTHOR = "author-user-id"


class _Users:
    def get_user(self, user_id: str) -> dict[str, str]:
        assert user_id == _AUTHOR
        return {"id": _AUTHOR, "username": "ada"}


class _Channels:
    def __init__(self) -> None:
        self.asked: list[str] = []

    def get_channel(self, channel_id: str) -> dict[str, str]:
        self.asked.append(channel_id)
        return {"id": channel_id, "type": "P"}


def _adapter() -> tuple[MattermostAdapter, list[Any], _Channels]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm",
            admin_user="admin",
            admin_password="pw",
            team_name="team",
        )
    )
    channels = _Channels()
    adapter._admin_driver = type(  # type: ignore[assignment]
        "_Driver", (), {"users": _Users(), "channels": channels}
    )()
    adapter._admin_user_id = "admin-user-id"
    adapter._bridge_bot_ids.add("bot-user-id")
    received: list[Any] = []

    async def record(event: Any) -> None:
        received.append(event)

    adapter._on_message = record
    adapter._on_command = record
    return adapter, received, channels


def _deliver(adapter: MattermostAdapter, *events: dict[str, Any]) -> None:
    loop = asyncio.new_event_loop()
    dispatched: list[Any] = []
    adapter._main_loop = loop
    adapter._dispatch = lambda coro, _loop: dispatched.append(coro)  # type: ignore[method-assign]
    try:
        for event in events:
            loop.run_until_complete(adapter._ws_handler(json.dumps(event), "helper"))
        for coro in dispatched:
            loop.run_until_complete(coro)
    finally:
        loop.close()


def _post(
    message: str,
    *,
    post_id: str = "post-1",
    edit_at: int = 1700,
    user_id: str = _AUTHOR,
    root_id: str = "",
    post_type: str = "",
) -> dict[str, Any]:
    return {
        "id": post_id,
        "user_id": user_id,
        "channel_id": "channel-1",
        "message": message,
        "root_id": root_id,
        "edit_at": edit_at,
        "type": post_type,
        "props": {},
    }


def _edited(post: dict[str, Any]) -> dict[str, Any]:
    # Unlike `posted`, Mattermost's `post_edited` carries only the post.
    return {"event": "post_edited", "data": {"post": json.dumps(post)}}


def _posted(post: dict[str, Any]) -> dict[str, Any]:
    return {
        "event": "posted",
        "data": {"post": json.dumps(post), "channel_type": "P"},
    }


def test_an_edit_is_relayed_as_an_edit_of_the_post() -> None:
    adapter, received, channels = _adapter()

    _deliver(adapter, _edited(_post("look at the file", root_id="root-1")))

    [message] = received
    assert isinstance(message, InboundMessage)
    assert message.edit_revision == "1700"
    assert message.message_ref == "post-1"
    assert message.content == "look at the file"
    assert message.root_id == "root-1"
    assert (message.sender_id, message.sender_name) == (_AUTHOR, "ada")
    assert message.agent_name == "helper"
    # The event names no channel type, so it is read from the channel.
    assert message.channel_type == "channel_private"
    assert channels.asked == ["channel-1"]


def test_the_same_edit_on_every_bots_socket_is_relayed_once() -> None:
    adapter, received, _ = _adapter()
    edit = _edited(_post("look at the file"))

    _deliver(adapter, edit, edit)

    assert len(received) == 1


def test_a_later_edit_of_the_same_post_is_relayed_again() -> None:
    adapter, received, _ = _adapter()

    _deliver(
        adapter,
        _edited(_post("look at the file", edit_at=1700)),
        _edited(_post("look at the files", edit_at=1800)),
    )

    assert [m.edit_revision for m in received] == ["1700", "1800"]


def test_a_post_already_seen_as_posted_can_still_be_edited() -> None:
    adapter, received, _ = _adapter()

    _deliver(
        adapter,
        _posted(_post("look at teh file", edit_at=0)),
        _edited(_post("look at the file", edit_at=1700)),
    )

    assert [m.edit_revision for m in received] == [None, "1700"]


def test_a_change_that_did_not_move_edit_at_is_not_an_edit() -> None:
    """A pin, a reaction: Mattermost sends `post_edited` without an edit."""
    adapter, received, _ = _adapter()

    _deliver(adapter, _edited(_post("look at the file", edit_at=0)))

    assert received == []


def test_the_bridges_own_card_redraws_are_not_relayed() -> None:
    adapter, received, _ = _adapter()

    _deliver(
        adapter,
        _edited(_post("Working…", user_id="bot-user-id")),
        _edited(_post("Working…", user_id="admin-user-id")),
    )

    assert received == []


def test_a_system_post_is_not_relayed() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _edited(_post("ada pinned a post", post_type="system_generic")))

    assert received == []


def test_editing_a_post_into_a_command_runs_nothing() -> None:
    adapter, received, _ = _adapter()

    _deliver(adapter, _edited(_post("!reset @helper")))

    assert received == []
