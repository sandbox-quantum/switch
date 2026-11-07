from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from switch_core.bridges.collaboration.adapter import ChannelCreationUnsupported
from switch_core.bridges.collaboration.google_chat.adapter import (
    GoogleChatAdapter,
    GoogleChatConnectionConfig,
)
from switch_core.bridges.collaboration.google_chat.chunking import split_message
from switch_core.bridges.collaboration.install import WebhookRequest
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    InboundAppJoin,
    InboundCommand,
    InboundMessage,
)


def _make_sa_json(client_email: str = "test-bot@gserviceaccount.com") -> str:
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "test-project",
            "private_key_id": "key-id-123",
            "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n",
            "client_email": client_email,
            "client_id": "1234567890",
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


def _make_config(**kwargs: Any) -> GoogleChatConnectionConfig:
    defaults = {
        "service_account_json": _make_sa_json(),
        "verification_token": "secret-verification-token",
        "max_attachment_size_bytes": 1024 * 1024,
    }
    defaults.update(kwargs)
    return GoogleChatConnectionConfig(**defaults)


# ── Config Validation ─────────────────────────────────────────────────────────


def test_config_valid() -> None:
    cfg = _make_config()
    sa = cfg.parsed_service_account()
    assert sa["client_email"] == "test-bot@gserviceaccount.com"


def test_config_invalid_json() -> None:
    with pytest.raises(ValueError, match="not valid JSON"):
        GoogleChatConnectionConfig(
            service_account_json="not-json", verification_token=None
        )


def test_config_missing_required_fields() -> None:
    with pytest.raises(ValueError, match="missing required fields"):
        GoogleChatConnectionConfig(
            service_account_json=json.dumps({"client_email": "a@b.com"}),
            verification_token=None,
        )


# ── Credential Verification ───────────────────────────────────────────────────


async def test_verify_credentials_success() -> None:
    cfg = _make_config().model_dump()
    await GoogleChatAdapter.verify_credentials(cfg)


async def test_verify_credentials_invalid_key() -> None:
    sa = json.loads(_make_sa_json())
    sa["private_key"] = "bad-key-without-header"
    cfg = _make_config(service_account_json=json.dumps(sa)).model_dump()

    with pytest.raises(BridgeCredentialError, match="Invalid private_key format"):
        await GoogleChatAdapter.verify_credentials(cfg)


# ── Chunking ──────────────────────────────────────────────────────────────────


def test_split_message_short() -> None:
    assert split_message("hello world", limit=20) == ["hello world"]


def test_split_message_long() -> None:
    text = "line1\nline2\nline3\nline4\nline5"
    chunks = split_message(text, limit=12)
    assert len(chunks) > 1
    assert all(len(c) <= 12 for c in chunks)


# ── Adapter Lifecycle & Capabilities ──────────────────────────────────────────


def test_adapter_capabilities() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    assert adapter.display_name == "Google Chat"
    assert adapter.receives_webhooks is True
    assert adapter.keeps_quiet_unless_listening is False
    assert adapter.supports_channel_creation is False
    assert adapter.supports_directory_search is False
    assert adapter.channel_on_delete == "kept"


def test_exclusive_resource() -> None:
    cfg = _make_config(
        service_account_json=_make_sa_json("Ops-Bot@ServiceAccount.Com")
    ).model_dump()
    res = GoogleChatAdapter.exclusive_resource(cfg)
    assert res == "google-chat:ops-bot@serviceaccount.com"


async def test_create_channel_raises_unsupported() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("new-space", "topic")


# ── Webhook Verification & Inbound Event Handling ─────────────────────────────


async def test_verify_webhook_valid() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    req = WebhookRequest(
        method="POST",
        headers={},
        query={},
        body=json.dumps({"token": "secret-verification-token"}).encode(),
    )
    await adapter.verify_webhook(req)


async def test_verify_webhook_invalid_token() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    req = WebhookRequest(
        method="POST",
        headers={},
        query={},
        body=json.dumps({"token": "wrong-token"}).encode(),
    )
    with pytest.raises(BridgeCredentialError, match="token mismatch"):
        await adapter.verify_webhook(req)


def test_parse_webhook_message_event_id() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    req = WebhookRequest(
        method="POST",
        headers={},
        query={},
        body=json.dumps(
            {
                "type": "MESSAGE",
                "eventTime": "2026-11-06T10:46:12Z",
                "message": {
                    "name": "spaces/AAAABBBB/messages/msg123",
                    "text": "hello",
                },
            }
        ).encode(),
    )
    inbound = adapter.parse_webhook(req)
    assert inbound.envelope_type == "MESSAGE"
    # external_event_id must be message.name for deduplication
    assert inbound.external_event_id == "spaces/AAAABBBB/messages/msg123"
    assert inbound.answers_inline is False


def test_parse_webhook_added_to_space_fallback_event_id() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    req = WebhookRequest(
        method="POST",
        headers={},
        query={},
        body=json.dumps(
            {
                "type": "ADDED_TO_SPACE",
                "eventTime": "2026-11-06T10:46:12Z",
                "space": {"name": "spaces/AAAABBBB"},
            }
        ).encode(),
    )
    inbound = adapter.parse_webhook(req)
    assert inbound.envelope_type == "ADDED_TO_SPACE"
    assert inbound.external_event_id == "2026-11-06T10:46:12Z"


async def test_dispatch_inbound_message() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    payload = {
        "type": "MESSAGE",
        "space": {"name": "spaces/AAAABBBB", "displayName": "General"},
        "message": {
            "name": "spaces/AAAABBBB/messages/msg123",
            "text": "Hello bot, what is the status?",
            "thread": {"name": "spaces/AAAABBBB/threads/th456"},
        },
        "user": {
            "name": "users/11223344",
            "displayName": "Alice",
            "type": "HUMAN",
        },
    }

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)

    assert len(received_messages) == 1
    msg = received_messages[0]
    assert msg.channel_id == "spaces/AAAABBBB"
    assert msg.sender_id == "users/11223344"
    assert msg.sender_name == "Alice"
    assert msg.content == "Hello bot, what is the status?"
    assert msg.message_ref == "spaces/AAAABBBB/messages/msg123"
    assert msg.root_id == "spaces/AAAABBBB/threads/th456"


async def test_dispatch_inbound_command() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    received_commands: list[InboundCommand] = []

    async def on_command(cmd: InboundCommand) -> None:
        received_commands.append(cmd)

    await adapter.start(
        on_message=MagicMock(),
        on_command=on_command,
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    payload = {
        "type": "MESSAGE",
        "space": {"name": "spaces/AAAABBBB"},
        "message": {
            "name": "spaces/AAAABBBB/messages/cmd123",
            "text": "!restart cluster-1",
        },
        "user": {
            "name": "users/11223344",
            "displayName": "Alice",
            "type": "HUMAN",
        },
    }

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)

    assert len(received_commands) == 1
    cmd = received_commands[0]
    assert cmd.command == "restart"
    assert cmd.args == "cluster-1"
    assert cmd.sender_name == "Alice"


async def test_dispatch_bot_message_ignored() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    received_messages: list[InboundMessage] = []

    async def on_message(msg: InboundMessage) -> None:
        received_messages.append(msg)

    await adapter.start(
        on_message=on_message,
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=MagicMock(),
    )

    payload = {
        "type": "MESSAGE",
        "message": {"text": "I am a bot reply"},
        "user": {"type": "BOT"},
    }

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)
    assert len(received_messages) == 0


async def test_dispatch_app_joined() -> None:
    adapter = GoogleChatAdapter(config=_make_config())
    received_joins: list[InboundAppJoin] = []

    async def on_app_joined(join: InboundAppJoin) -> None:
        received_joins.append(join)

    await adapter.start(
        on_message=MagicMock(),
        on_command=MagicMock(),
        on_agent_joined=MagicMock(),
        on_user_joined=MagicMock(),
        on_app_joined=on_app_joined,
    )

    payload = {
        "type": "ADDED_TO_SPACE",
        "space": {"name": "spaces/AAAABBBB", "displayName": "Engineering"},
    }

    await adapter.dispatch_event(envelope_type="ADDED_TO_SPACE", payload=payload)
    assert len(received_joins) == 1
    assert received_joins[0].channel_id == "spaces/AAAABBBB"
    assert received_joins[0].channel_name == "Engineering"


# ── Outbound Messaging ────────────────────────────────────────────────────────


async def test_send_message_invokes_http_endpoint() -> None:
    from unittest.mock import AsyncMock

    adapter = GoogleChatAdapter(config=_make_config())
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"name": "spaces/AAAABBBB/messages/out999"}

    with patch.object(adapter, "_get_token", return_value="fake-token"):
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=mock_resp)
        adapter._http_client = mock_client

        msg_ref = await adapter.send_message(
            channel_id="spaces/AAAABBBB",
            sender_name="Claude Agent",
            content="Task completed successfully.",
            thread_root_id="spaces/AAAABBBB/threads/th456",
        )

        assert msg_ref == "spaces/AAAABBBB/messages/out999"
        mock_client.post.assert_called_once()
        call_kwargs = mock_client.post.call_args[1]
        assert "spaces/AAAABBBB/messages" in mock_client.post.call_args[0][0]
        assert "Task completed successfully." in call_kwargs["json"]["text"]
        assert call_kwargs["json"]["thread"]["name"] == "spaces/AAAABBBB/threads/th456"
