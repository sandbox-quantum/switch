from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from switch_core.bridges.collaboration.adapter import ChannelCreationUnsupported
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.bridges.collaboration.rocketchat.chunking import (
    split_rocketchat_message,
)


def _make_config(**kwargs: Any) -> RocketChatConnectionConfig:
    defaults = {
        "server_url": "https://chat.example.com",
        "user_id": "bot-user-id-123",
        "auth_token": "secret-auth-token",
        "max_attachment_size_bytes": 1024 * 1024,
    }
    defaults.update(kwargs)
    return RocketChatConnectionConfig(**defaults)


# ── Config Validation ─────────────────────────────────────────────────────────


def test_config_valid() -> None:
    cfg = _make_config()
    assert cfg.server_url == "https://chat.example.com"
    assert cfg.user_id == "bot-user-id-123"


def test_config_invalid_url() -> None:
    with pytest.raises(ValueError, match="must start with http"):
        RocketChatConnectionConfig(
            server_url="ftp://invalid.com",
            user_id="bot123",
            auth_token="token",
        )


# ── Chunking ──────────────────────────────────────────────────────────────────


def test_split_rocketchat_message_short() -> None:
    assert split_rocketchat_message("short text", limit=20) == ["short text"]


def test_split_rocketchat_message_long() -> None:
    text = "line1\nline2\nline3\nline4\nline5"
    chunks = split_rocketchat_message(text, limit=12)
    assert len(chunks) > 1
    assert all(len(c) <= 12 for c in chunks)


# ── Credential Verification ───────────────────────────────────────────────────


async def test_verify_credentials_success() -> None:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"active": True}

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        await RocketChatAdapter.verify_credentials(_make_config().model_dump())
        mock_get.assert_called_once()


async def test_verify_credentials_unauthorized() -> None:
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.text = "Unauthorized"

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        with pytest.raises(
            BridgeCredentialError, match="Invalid user_id or auth_token"
        ):
            await RocketChatAdapter.verify_credentials(_make_config().model_dump())


# ── Adapter Capabilities ──────────────────────────────────────────────────────


def test_adapter_capabilities() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    assert adapter.display_name == "Rocket.Chat"
    assert adapter.keeps_quiet_unless_listening is True
    assert adapter.receives_webhooks is False
    assert adapter.supports_channel_creation is False
    assert adapter.supports_directory_search is True
    assert adapter.channel_on_delete == "archived"


def test_exclusive_resource() -> None:
    cfg = _make_config(
        server_url="https://Chat.Company.Com",
        user_id="Bot-User-999",
    ).model_dump()
    res = RocketChatAdapter.exclusive_resource(cfg)
    assert res == "rocketchat:chat.company.com:bot-user-999"


async def test_create_channel_raises_unsupported() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("general", "topic")


# ── Inbound Message Processing ────────────────────────────────────────────────


async def test_process_inbound_message() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    received: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw_msg = {
        "_id": "msg-7788",
        "rid": "general-room",
        "msg": "Hello team, let's ship today",
        "tmid": "thread-root-1122",
        "u": {
            "_id": "user-456",
            "username": "alice",
            "name": "Alice Developer",
        },
    }

    await adapter._process_message(raw_msg)

    assert len(received) == 1
    msg = received[0]
    assert msg.channel_id == "general-room"
    assert msg.sender_id == "user-456"
    assert msg.sender_name == "Alice Developer"
    assert msg.content == "Hello team, let's ship today"
    assert msg.message_ref == "msg-7788"
    assert msg.root_id == "thread-root-1122"


async def test_process_inbound_command() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    received_cmds: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        received_cmds.append(cmd)

    await adapter.start(
        on_message=MagicMock(),
        on_command=on_command,
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw_msg = {
        "_id": "cmd-1234",
        "rid": "general-room",
        "msg": "!deploy production --tag=v1.2",
        "u": {
            "_id": "user-456",
            "username": "alice",
        },
    }

    await adapter._process_message(raw_msg)

    assert len(received_cmds) == 1
    cmd = received_cmds[0]
    assert cmd.command == "deploy"
    assert cmd.args == "production --tag=v1.2"
    assert cmd.channel_id == "general-room"


async def test_process_self_echo_ignored() -> None:
    adapter = RocketChatAdapter(config=_make_config(user_id="bot-user-id-123"))
    received: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    raw_msg = {
        "_id": "msg-self",
        "rid": "general-room",
        "msg": "I posted this",
        "u": {"_id": "bot-user-id-123"},
    }

    await adapter._process_message(raw_msg)
    assert len(received) == 0


# ── Outbound Messaging ────────────────────────────────────────────────────────


async def test_send_message_dispatches_http_post() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"message": {"_id": "out-9988"}}

    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    adapter._http_client = mock_client

    ref = await adapter.send_message(
        channel_id="general-room",
        sender_name="Claude Agent",
        content="Rocket.Chat message sent.",
        thread_root_id="thread-root-1122",
    )

    assert ref == "out-9988"
    mock_client.post.assert_called_once()
    payload = mock_client.post.call_args[1]["json"]
    assert payload["roomId"] == "general-room"
    assert payload["tmid"] == "thread-root-1122"
    assert "Rocket.Chat message sent." in payload["text"]


# ── Server-Side Checkpoint & Sync ─────────────────────────────────────────────


async def test_sync_room_messages_uses_ls_and_marks_read() -> None:
    adapter = RocketChatAdapter(config=_make_config())
    received: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    sync_resp = MagicMock()
    sync_resp.status_code = 200
    sync_resp.json.return_value = {
        "result": {
            "updated": [
                {
                    "_id": "msg-sync-1",
                    "rid": "room-abc",
                    "msg": "Hello synced",
                    "u": {"_id": "other-user", "username": "bob"},
                }
            ]
        }
    }

    mock_client = MagicMock()
    mock_client.get = AsyncMock(return_value=sync_resp)
    mock_client.post = AsyncMock(return_value=MagicMock(status_code=200))

    await adapter._sync_room_messages(mock_client, "room-abc", "2026-11-06T10:00:00Z")

    assert len(received) == 1
    assert received[0].message_ref == "msg-sync-1"

    # Verify lastUpdate was sent in sync query
    mock_client.get.assert_called_once()
    assert (
        mock_client.get.call_args[1]["params"]["lastUpdate"] == "2026-11-06T10:00:00Z"
    )

    # Verify room was marked read on server to advance checkpoint
    mock_client.post.assert_called_once()
    assert "/subscriptions.read" in mock_client.post.call_args[0][0]
    assert mock_client.post.call_args[1]["json"]["rid"] == "room-abc"
