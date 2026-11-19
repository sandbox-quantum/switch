"""Mattermost reports a channel's new display name as a system post in the
channel, which every agent bot's socket receives. The bridge hands the rename
to the room once and never relays the post as chat."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import InboundMessage


async def _adapter() -> tuple[MattermostAdapter, list[tuple[str, str, str]], list[Any]]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    renamed: list[tuple[str, str, str]] = []
    relayed: list[InboundMessage] = []

    async def named(channel_id: str, old: str, new: str) -> None:
        renamed.append((channel_id, old, new))

    async def message(msg: InboundMessage) -> None:
        relayed.append(msg)

    adapter.set_channel_rename_handler(named)
    adapter._on_message = message
    adapter._main_loop = asyncio.get_running_loop()
    return adapter, renamed, relayed


def _posted(post: dict[str, Any]) -> str:
    return json.dumps(
        {
            "event": "posted",
            "data": {
                "channel_display_name": "Release Train 2026",
                "channel_type": "O",
                "post": json.dumps(post),
            },
        }
    )


def _rename_post(props: dict[str, str]) -> dict[str, Any]:
    return {
        "id": "post-1",
        "channel_id": "chan-1",
        "user_id": "user-1",
        "type": "system_displayname_change",
        "message": "user-1 updated the channel display name",
        "props": props,
    }


async def test_a_display_name_change_reaches_the_room_once() -> None:
    adapter, renamed, relayed = await _adapter()
    event = _posted(
        _rename_post(
            {
                "old_displayname": "Release Train",
                "new_displayname": "Release Train 2026",
            }
        )
    )
    # Two agents in the channel: two sockets, the same post.
    await adapter._ws_handler(event, "agent-a")
    await adapter._ws_handler(event, "agent-b")
    # Handed to the main loop, as a message is.
    await asyncio.sleep(0.05)
    assert renamed == [("chan-1", "Release Train", "Release Train 2026")]
    assert relayed == []


async def test_a_change_without_a_new_name_is_skipped_loudly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, renamed, relayed = await _adapter()
    await adapter._ws_handler(
        _posted(_rename_post({"old_displayname": "Release Train"})), "agent-a"
    )
    assert renamed == [] and relayed == []
    assert "without a channel or a new name" in caplog.text


async def test_other_system_posts_are_still_ignored() -> None:
    adapter, renamed, relayed = await _adapter()
    post = _rename_post({})
    post["type"] = "system_header_change"
    await adapter._ws_handler(_posted(post), "agent-a")
    assert renamed == [] and relayed == []
