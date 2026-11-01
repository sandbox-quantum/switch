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
from switch_core.bridges.collaboration.zulip.adapter import (
    ZulipAdapter,
    ZulipConnectionConfig,
)
from switch_core.bridges.collaboration.zulip.chunking import split_zulip_message


def _make_config(**kwargs: Any) -> ZulipConnectionConfig:
    defaults = {
        "site_url": "https://zulip.example.com",
        "bot_email": "agent-bot@zulip.example.com",
        "api_key": "secret-api-key",
        "max_attachment_size_bytes": 1024 * 1024,
    }
    defaults.update(kwargs)
    return ZulipConnectionConfig(**defaults)


# ── Config Validation ─────────────────────────────────────────────────────────


def test_config_valid() -> None:
    cfg = _make_config()
    assert cfg.site_url == "https://zulip.example.com"
    assert cfg.bot_email == "agent-bot@zulip.example.com"


def test_config_invalid_url() -> None:
    with pytest.raises(ValueError, match="must start with http"):
        ZulipConnectionConfig(
            site_url="ftp://invalid.com",
            bot_email="bot@example.com",
            api_key="key",
        )


def test_config_invalid_email() -> None:
    with pytest.raises(ValueError, match="valid email"):
        ZulipConnectionConfig(
            site_url="https://zulip.example.com",
            bot_email="not-an-email",
            api_key="key",
        )


# ── Chunking ──────────────────────────────────────────────────────────────────


def test_split_zulip_message_short() -> None:
    assert split_zulip_message("short message", limit=50) == ["short message"]


def test_split_zulip_message_long() -> None:
    text = "part1\npart2\npart3\npart4"
    chunks = split_zulip_message(text, limit=10)
    assert len(chunks) > 1
    assert all(len(c) <= 10 for c in chunks)


# ── Credential Verification ───────────────────────────────────────────────────


async def test_verify_credentials_success() -> None:
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"is_active": True}

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        await ZulipAdapter.verify_credentials(_make_config().model_dump())
        mock_get.assert_called_once()


async def test_verify_credentials_unauthorized() -> None:
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.text = "Unauthorized"

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        with pytest.raises(BridgeCredentialError, match="Invalid bot_email or api_key"):
            await ZulipAdapter.verify_credentials(_make_config().model_dump())


# ── Adapter Lifecycle & Capabilities ──────────────────────────────────────────


def test_adapter_capabilities() -> None:
    adapter = ZulipAdapter(config=_make_config())
    assert adapter.display_name == "Zulip"
    assert adapter.keeps_quiet_unless_listening is True
    assert adapter.receives_webhooks is False
    assert adapter.supports_channel_creation is False
    assert adapter.supports_directory_search is True
    assert adapter.channel_on_delete == "kept"


def test_exclusive_resource() -> None:
    cfg = _make_config(
        site_url="https://Chat.Company.Com",
        bot_email="Bot-1@Company.Com",
    ).model_dump()
    res = ZulipAdapter.exclusive_resource(cfg)
    assert res == "zulip:chat.company.com:bot-1@company.com"


async def test_create_channel_raises_unsupported() -> None:
    adapter = ZulipAdapter(config=_make_config())
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("general", "topic")


# ── Inbound Event Processing ──────────────────────────────────────────────────


async def test_process_inbound_message() -> None:
    adapter = ZulipAdapter(config=_make_config())
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

    ev = {
        "type": "message",
        "message": {
            "id": 98765,
            "sender_id": 42,
            "sender_email": "alice@zulip.example.com",
            "sender_full_name": "Alice Developer",
            "display_recipient": "dev-stream",
            "subject": "Deployment Q4",
            "content": "Can we deploy the new release?",
        },
    }

    await adapter._process_event(ev)

    assert len(received) == 1
    msg = received[0]
    assert msg.channel_id == "dev-stream"
    assert msg.sender_id == "42"
    assert msg.sender_name == "Alice Developer"
    assert msg.content == "Can we deploy the new release?"
    assert msg.message_ref == "98765"
    assert msg.root_id == "Deployment Q4"


async def test_process_inbound_command() -> None:
    adapter = ZulipAdapter(config=_make_config())
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

    ev = {
        "type": "message",
        "message": {
            "id": 11223,
            "sender_id": 42,
            "sender_email": "alice@zulip.example.com",
            "sender_full_name": "Alice Developer",
            "display_recipient": "dev-stream",
            "subject": "Ops Topic",
            "content": "!build --release",
        },
    }

    await adapter._process_event(ev)

    assert len(received_cmds) == 1
    cmd = received_cmds[0]
    assert cmd.command == "build"
    assert cmd.args == "--release"
    assert cmd.channel_id == "dev-stream"
    assert cmd.root_id == "Ops Topic"


async def test_process_self_echo_ignored() -> None:
    adapter = ZulipAdapter(config=_make_config(bot_email="bot@zulip.example.com"))
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

    ev = {
        "type": "message",
        "message": {
            "id": 99999,
            "sender_email": "bot@zulip.example.com",
            "content": "Self echo",
        },
    }

    await adapter._process_event(ev)
    assert len(received) == 0


# ── Outbound Dispatch ─────────────────────────────────────────────────────────


async def test_send_message_dispatches_http_post() -> None:
    adapter = ZulipAdapter(config=_make_config())
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"id": 554433}

    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    adapter._http_client = mock_client

    ref = await adapter.send_message(
        channel_id="engineering",
        sender_name="Claude Agent",
        content="Testing Zulip outbound.",
        thread_root_id="backend-infra",
    )

    assert ref == "554433"
    mock_client.post.assert_called_once()
    data = mock_client.post.call_args[1]["data"]
    assert data["type"] == "stream"
    assert data["to"] == "engineering"
    assert data["topic"] == "backend-infra"
    assert "Testing Zulip outbound." in data["content"]
