"""Tests for Slack channel lifecycle handling: archive, unarchive, deleted, and outbound terminal errors."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from switch_core.bridges.collaboration.adapter import (
    ChannelArchivedError,
    ChannelNotFoundError,
)
from switch_core.bridges.collaboration.collaboration_core import CollaborationCore
from switch_core.clients.actor import SystemActor


def _noop(*_args: Any, **_kwargs: Any) -> Any:
    return None


def _make_event(
    body: str = "hello", event_id: str = "$msg1", sender_name: str = "Alice"
) -> Any:
    return SimpleNamespace(
        content={"body": body},
        event_id=event_id,
        sender="@user:switch.local",
        sender_name=sender_name,
        body=body,
    )


class _FakeAdmin(SystemActor):
    def __init__(self) -> None:
        self.notices: list[tuple[str, str]] = []

    async def send_admin(
        self,
        room_id: str,
        body: str,
        *,
        message_type: Any = None,
        thread_root_id: str | None = None,
        mentions: list[str] | None = None,
    ) -> str:
        self.notices.append((room_id, body))
        return "$admin_event"


def _make_core() -> tuple[CollaborationCore, _FakeAdmin, AsyncMock]:
    core = object.__new__(CollaborationCore)
    core._bridge_id = "bridge-1"
    core._bridge_tenant_id = "tenant-1"
    core._bridge_type = "slack"
    core._archived_channels = set()
    core._deleted_channels = set()
    core._channel_to_room = {"C123": ("room-1", "!transport-room-1")}
    core._room_to_channel = {("room-1", "!transport-room-1"): "C123"}
    core._room_tenants = {"room-1": "tenant-1"}

    fake_admin = _FakeAdmin()
    client_lifecycle = MagicMock()
    client_lifecycle.get_by_type.return_value = [fake_admin]
    core._client_lifecycle = client_lifecycle

    room_service = AsyncMock()
    core._room_service = room_service

    adapter = MagicMock()
    adapter._channel_name_cache = {"C123": "general"}
    adapter.channel_name_for = lambda name: name
    core._adapter = adapter

    return core, fake_admin, room_service


@pytest.mark.asyncio
async def test_handle_channel_archived_and_unarchived() -> None:
    core, admin, _ = _make_core()

    # First archive event: posts notice and marks channel archived
    await core._handle_channel_archived("C123")
    assert "C123" in core._archived_channels
    assert len(admin.notices) == 1
    assert "The bridged Slack channel #general was archived" in admin.notices[0][1]
    assert admin.notices[0][0] == "!transport-room-1"

    # Duplicate archive event: deduplicated, no new notice
    await core._handle_channel_archived("C123")
    assert len(admin.notices) == 1

    # Unarchive event: posts resumption notice and clears archived state
    await core._handle_channel_unarchived("C123")
    assert "C123" not in core._archived_channels
    assert len(admin.notices) == 2
    assert (
        "The bridged Slack channel #general was unarchived. Relay resumed."
        in admin.notices[1][1]
    )

    # Duplicate unarchive event: no notice
    await core._handle_channel_unarchived("C123")
    assert len(admin.notices) == 2


@pytest.mark.asyncio
async def test_handle_channel_deleted() -> None:
    core, admin, room_service = _make_core()

    await core._handle_channel_deleted("C123")
    assert "C123" in core._deleted_channels
    assert "C123" not in core._channel_to_room
    assert ("room-1", "!transport-room-1") not in core._room_to_channel

    # Notice posted
    assert len(admin.notices) == 1
    assert (
        "The bridged Slack channel #general was deleted. This room is no longer bridged to Slack."
        in admin.notices[0][1]
    )

    # Room unlinked
    room_service.unlink_bridge_channel.assert_awaited_once_with("bridge-1", "C123")


@pytest.mark.asyncio
async def test_relay_outbound_skips_when_channel_is_archived() -> None:
    core, _, _ = _make_core()
    core._archived_channels.add("C123")
    core._post_outbound_message = AsyncMock()  # type: ignore[method-assign]

    event = _make_event()

    await core._relay_outbound_message("C123", event)
    # Never called post
    core._post_outbound_message.assert_not_called()


@pytest.mark.asyncio
async def test_relay_outbound_catches_terminal_archived_error() -> None:
    core, admin, _ = _make_core()
    core._outbound_thread_root_ref = AsyncMock(return_value=None)  # type: ignore[method-assign]
    core._claim_outbound = AsyncMock(return_value=True)  # type: ignore[method-assign]
    core._release_outbound = AsyncMock()  # type: ignore[method-assign]

    async def fail_post(*_args: Any, **_kwargs: Any) -> None:
        raise ChannelArchivedError("C123", "is_archived")

    core._post_outbound_message = fail_post  # type: ignore[method-assign]

    event = _make_event()

    await core._relay_outbound_message("C123", event)

    # Claim was released
    core._release_outbound.assert_awaited_once_with("$msg1")
    # Channel marked archived
    assert "C123" in core._archived_channels
    # Admin notice sent
    assert len(admin.notices) == 1
    assert "was archived" in admin.notices[0][1]


@pytest.mark.asyncio
async def test_relay_outbound_catches_terminal_not_found_error() -> None:
    core, admin, room_service = _make_core()
    core._outbound_thread_root_ref = AsyncMock(return_value=None)  # type: ignore[method-assign]
    core._claim_outbound = AsyncMock(return_value=True)  # type: ignore[method-assign]
    core._release_outbound = AsyncMock()  # type: ignore[method-assign]

    async def fail_post(*_args: Any, **_kwargs: Any) -> None:
        raise ChannelNotFoundError("C123", "channel_not_found")

    core._post_outbound_message = fail_post  # type: ignore[method-assign]

    event = _make_event()

    await core._relay_outbound_message("C123", event)

    # Claim was released
    core._release_outbound.assert_awaited_once_with("$msg1")
    # Channel marked deleted and unmapped
    assert "C123" in core._deleted_channels
    assert "C123" not in core._channel_to_room
    # Admin notice sent
    assert len(admin.notices) == 1
    assert "was deleted" in admin.notices[0][1]
    room_service.unlink_bridge_channel.assert_awaited_once_with("bridge-1", "C123")
