"""What is taken back on Mattermost reaches the bridge: a post deleted or
edited, a channel archived or deleted for good. Every agent bot's socket
receives the event, and each is reported once."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import pytest
from mattermostdriver.exceptions import ResourceNotFound

from switch_core.bridges.collaboration.mattermost.adapter import (
    MattermostAdapter,
    MattermostConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    InboundChannelRemoved,
    InboundMessageDeleted,
    InboundMessageEdited,
)

_BRIDGE_BOT = "bridge-bot-id"


class _Channels:
    def __init__(self, channels: dict[str, dict[str, Any]]) -> None:
        self._channels = channels

    def get_channel(self, channel_id: str) -> dict[str, Any]:
        if channel_id not in self._channels:
            raise ResourceNotFound("not found")
        return self._channels[channel_id]


class _Takebacks:
    def __init__(self) -> None:
        self.deleted: list[InboundMessageDeleted] = []
        self.edited: list[InboundMessageEdited] = []
        self.removed: list[InboundChannelRemoved] = []

    async def on_deleted(self, event: InboundMessageDeleted) -> None:
        self.deleted.append(event)

    async def on_edited(self, event: InboundMessageEdited) -> None:
        self.edited.append(event)

    async def on_removed(self, event: InboundChannelRemoved) -> None:
        self.removed.append(event)


async def _adapter(
    channels: dict[str, dict[str, Any]],
) -> tuple[MattermostAdapter, _Takebacks]:
    adapter = MattermostAdapter(
        config=MattermostConnectionConfig(
            url="http://mm", admin_user="admin", admin_password="pw", team_name="team"
        )
    )
    takebacks = _Takebacks()
    adapter.set_takeback_handlers(
        on_message_deleted=takebacks.on_deleted,
        on_message_edited=takebacks.on_edited,
        on_channel_removed=takebacks.on_removed,
    )
    adapter._bridge_bot_ids.add(_BRIDGE_BOT)
    adapter._admin_driver = type("_Driver", (), {"channels": _Channels(channels)})()  # type: ignore[assignment]
    adapter._main_loop = asyncio.get_running_loop()
    return adapter, takebacks


async def _deliver(adapter: MattermostAdapter, event: dict[str, Any]) -> None:
    await adapter._ws_handler(json.dumps(event), "some-agent")
    for _ in range(5):
        await asyncio.sleep(0)


def _post_event(event_type: str, **post: Any) -> dict[str, Any]:
    body = {
        "id": "post-1",
        "channel_id": "chan-1",
        "user_id": "user-1",
        "message": "hello",
        "type": "",
        "edit_at": 0,
    }
    body.update(post)
    return {
        "event": event_type,
        "data": {"post": json.dumps(body)},
        "broadcast": {"channel_id": body["channel_id"]},
    }


def _channel_deleted(channel_id: str) -> dict[str, Any]:
    return {
        "event": "channel_deleted",
        "data": {"channel_id": channel_id, "delete_at": 1700000000000},
        "broadcast": {"team_id": "team-1"},
    }


@pytest.mark.asyncio
async def test_a_deleted_post_is_reported_once_by_its_channel_and_post_id() -> None:
    adapter, takebacks = await _adapter({})

    await _deliver(adapter, _post_event("post_deleted"))
    await _deliver(adapter, _post_event("post_deleted"))

    assert takebacks.deleted == [
        InboundMessageDeleted(channel_id="chan-1", message_ref="post-1")
    ]


@pytest.mark.asyncio
async def test_an_edited_post_is_reported_with_its_new_words() -> None:
    adapter, takebacks = await _adapter({})

    await _deliver(adapter, _post_event("post_edited", message="hi", edit_at=1))
    await _deliver(adapter, _post_event("post_edited", message="hi", edit_at=1))
    await _deliver(adapter, _post_event("post_edited", message="hey", edit_at=2))

    assert takebacks.edited == [
        InboundMessageEdited(channel_id="chan-1", message_ref="post-1", content="hi"),
        InboundMessageEdited(channel_id="chan-1", message_ref="post-1", content="hey"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "post",
    [
        {"edit_at": 0},
        {"edit_at": 1, "user_id": _BRIDGE_BOT},
        {"edit_at": 1, "type": "system_join_channel"},
    ],
    ids=["never-edited", "bridge-bot-post", "system-post"],
)
async def test_an_update_that_is_not_a_persons_edit_is_ignored(
    post: dict[str, Any],
) -> None:
    adapter, takebacks = await _adapter({})

    await _deliver(adapter, _post_event("post_edited", **post))

    assert takebacks.edited == []


@pytest.mark.asyncio
async def test_an_archived_channel_is_reported_as_not_deleted() -> None:
    adapter, takebacks = await _adapter(
        {"chan-1": {"id": "chan-1", "delete_at": 1700000000000}}
    )

    await _deliver(adapter, _channel_deleted("chan-1"))
    await _deliver(adapter, _channel_deleted("chan-1"))

    assert takebacks.removed == [
        InboundChannelRemoved(channel_id="chan-1", deleted=False)
    ]


@pytest.mark.asyncio
async def test_a_channel_deleted_for_good_is_reported_as_deleted() -> None:
    adapter, takebacks = await _adapter({})

    await _deliver(adapter, _channel_deleted("chan-1"))

    assert takebacks.removed == [
        InboundChannelRemoved(channel_id="chan-1", deleted=True)
    ]


@pytest.mark.asyncio
async def test_a_channel_restored_before_it_is_checked_is_not_reported() -> None:
    adapter, takebacks = await _adapter({"chan-1": {"id": "chan-1", "delete_at": 0}})

    await _deliver(adapter, _channel_deleted("chan-1"))

    assert takebacks.removed == []


@pytest.mark.asyncio
async def test_a_failing_handler_is_logged_not_raised(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter, _ = await _adapter({})

    async def fail(event: InboundMessageDeleted) -> None:
        raise RuntimeError("store unavailable")

    adapter._on_message_deleted = fail

    with caplog.at_level(logging.ERROR):
        await _deliver(adapter, _post_event("post_deleted"))

    assert any("store unavailable" in r.getMessage() for r in caplog.records)
