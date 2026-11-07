"""Unit tests for the Rocket.Chat collaboration bridge adapter.

The Rocket.Chat REST API is mocked at the transport level with
httpx.MockTransport; realtime DDP frames are fed to the adapter directly.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from switch_core.bridges.collaboration.models import (
    Attachment,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)

SERVER = "https://chat.example.com"
ROOM_ID = "room123"
BOT_ID = "bot-user-id"


def _config(**overrides: Any) -> RocketChatConnectionConfig:
    return RocketChatConnectionConfig(
        server_url=SERVER, username="switch-bot", password="secret", **overrides
    )


def _transport(
    handler: Any,
) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(recording), calls


def _login_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "status": "success",
            "data": {
                "authToken": "token-123",
                "userId": BOT_ID,
                "me": {"username": "switch-bot"},
            },
        },
    )


def _adapter(
    transport: httpx.AsyncTransport | None = None,
) -> RocketChatAdapter:
    adapter = RocketChatAdapter(config=_config(), transport=transport)
    adapter._auth_token = "token-123"
    adapter._bot_user_id = BOT_ID
    adapter._bot_username = "switch-bot"
    return adapter


async def _started(adapter: RocketChatAdapter) -> dict[str, AsyncMock]:
    callbacks = {
        "on_message": AsyncMock(),
        "on_command": AsyncMock(),
        "on_agent_joined": AsyncMock(),
        "on_user_joined": AsyncMock(),
        "on_app_joined": AsyncMock(),
    }
    adapter.set_listening(False)
    await adapter.start(**callbacks)  # type: ignore[arg-type]
    return callbacks


def _stream_message(**overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "_id": "msg-1",
        "rid": ROOM_ID,
        "msg": "Hello world",
        "u": {"_id": "user-1", "username": "alice", "name": "Alice"},
    }
    message.update(overrides)
    return message


# --- Config ---------------------------------------------------------------


def test_config_valid() -> None:
    config = _config()
    assert config.server_url == SERVER
    assert config.username == "switch-bot"


def test_config_invalid_url() -> None:
    with pytest.raises(ValueError, match="server_url must use http or https"):
        RocketChatConnectionConfig(
            server_url="ftp://chat.example.com", username="u", password="p"
        )


def test_config_url_with_path_refused() -> None:
    with pytest.raises(ValueError, match="server_url must be the server root"):
        RocketChatConnectionConfig(
            server_url="https://chat.example.com/app", username="u", password="p"
        )


# --- verify_credentials -----------------------------------------------------


def _patch_login(monkeypatch: pytest.MonkeyPatch, response: Any) -> None:
    transport = httpx.MockTransport(lambda request: response)
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.rocketchat.adapter.httpx.AsyncClient",
        factory,
    )


async def test_verify_credentials_success(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_login(monkeypatch, _login_response())
    await RocketChatAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_bad_password(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_login(monkeypatch, httpx.Response(401, json={"error": "Unauthorized"}))
    with pytest.raises(Exception, match="rejected the credentials"):
        await RocketChatAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_server_down(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.rocketchat.adapter.httpx.AsyncClient",
        factory,
    )
    with pytest.raises(Exception, match="Could not reach the Rocket.Chat server"):
        await RocketChatAdapter.verify_credentials(_config().model_dump())


# --- Inbound: DDP stream messages -------------------------------------------


async def test_inbound_channel_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(_stream_message(), "c", ROOM_ID)
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert isinstance(msg, InboundMessage)
    assert msg.channel_id == ROOM_ID
    assert msg.sender_id == "user-1"
    assert msg.sender_name == "Alice"
    assert msg.content == "Hello world"
    assert msg.message_ref == "msg-1"
    assert msg.channel_type == "channel_public"
    assert msg.root_id is None


async def test_inbound_private_group_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(_stream_message(), "p", ROOM_ID)
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.channel_type == "channel_private"


async def test_inbound_thread_reply() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(tmid="parent-1"), "c", ROOM_ID
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.root_id == "parent-1"


async def test_inbound_own_message_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(u={"_id": BOT_ID, "username": "switch-bot"}), "c", ROOM_ID
    )
    callbacks["on_message"].assert_not_called()


async def test_inbound_dm_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(_stream_message(), "d", ROOM_ID)
    callbacks["on_message"].assert_not_called()


async def test_inbound_system_message_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(_stream_message(t="uj"), "c", ROOM_ID)
    callbacks["on_message"].assert_not_called()


async def test_inbound_dedup() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(_stream_message(), "c", ROOM_ID)
    callbacks["on_message"].assert_called_once()
    callbacks["on_message"].reset_mock()
    await adapter._process_stream_message(_stream_message(), "c", ROOM_ID)
    callbacks["on_message"].assert_not_called()


async def test_inbound_command() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(msg="!reset agent"), "c", ROOM_ID
    )
    callbacks["on_command"].assert_called_once()
    cmd = callbacks["on_command"].call_args[0][0]
    assert isinstance(cmd, InboundCommand)
    assert cmd.command == "reset"
    assert cmd.args == "agent"
    assert cmd.channel_id == ROOM_ID


async def test_inbound_self_mention() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(
            msg="@switch-bot hello",
            mentions=[{"_id": BOT_ID, "username": "switch-bot"}],
        ),
        "c",
        ROOM_ID,
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.self_mention_token == "switch-bot"


async def test_inbound_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/file-upload/abc123/report.txt":
            return httpx.Response(200, content=b"file body")
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(
            attachments=[
                {
                    "title": "report.txt",
                    "attachmentUrl": "/file-upload/abc123/report.txt",
                }
            ]
        ),
        "c",
        ROOM_ID,
    )
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert len(msg.attachments) == 1
    att = msg.attachments[0]
    assert isinstance(att, Attachment)
    assert att.filename == "report.txt"
    assert att.data == b"file body"


async def test_inbound_oversize_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"x" * 100, headers={"content-length": "100"}
        )

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    adapter._max_attachment_bytes = 10
    callbacks = await _started(adapter)

    await adapter._process_stream_message(
        _stream_message(
            attachments=[
                {"title": "big.bin", "attachmentUrl": "/file-upload/x/big.bin"}
            ]
        ),
        "c",
        ROOM_ID,
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.attachments == []
    assert len(msg.attachment_failures) == 1
    assert "exceeds maximum size" in msg.attachment_failures[0].reason


# --- DDP framing --------------------------------------------------------------


async def test_ddp_ping_pong() -> None:
    sent: list[str] = []

    class FakeWs:
        async def send(self, data: str) -> None:
            sent.append(data)

    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    await adapter._handle_ddp_message(FakeWs(), {"msg": "ping"})
    assert json.loads(sent[0]) == {"msg": "pong"}


async def test_ddp_changed_dispatches_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)
    payload = {
        "msg": "changed",
        "collection": "stream-room-messages",
        "fields": {"args": [_stream_message(), "c", ROOM_ID]},
    }
    await adapter._handle_ddp_message(MagicMock(), payload)
    callbacks["on_message"].assert_called_once()


# --- Outbound -----------------------------------------------------------------


async def test_send_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/chat.postMessage":
            return httpx.Response(
                200, json={"success": True, "message": {"_id": "sent-1"}}
            )
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=ROOM_ID, sender_name="Test Agent", content="Hello world"
    )
    assert ref == "sent-1"
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["roomId"] == ROOM_ID
    assert "Test Agent: Hello world" in body["text"]
    assert calls[0].headers["x-auth-token"] == "token-123"
    assert calls[0].headers["x-user-id"] == BOT_ID


async def test_send_message_threaded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path == "/api/v1/chat.postMessage":
            assert body["tmid"] == "parent-1"
            return httpx.Response(
                200, json={"success": True, "message": {"_id": "sent-2"}}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=ROOM_ID,
        sender_name="Test Agent",
        content="Reply",
        thread_root_id="parent-1",
    )
    assert ref == "sent-2"


async def test_update_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/chat.update":
            body = json.loads(request.content)
            assert body["msgId"] == "msg-1"
            assert body["roomId"] == ROOM_ID
            assert body["text"] == "Edited message"
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.update_message(
        channel_id=ROOM_ID, message_ref="msg-1", new_content="Edited message"
    )
    assert len(calls) == 1


async def test_delete_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/chat.delete":
            body = json.loads(request.content)
            assert body["msgId"] == "msg-1"
            assert body["roomId"] == ROOM_ID
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.delete_message(channel_id=ROOM_ID, message_ref="msg-1")
    assert len(calls) == 1


async def test_mark_activity_reacts() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/chat.react":
            body = json.loads(request.content)
            assert body["messageId"] == "msg-1"
            assert body["reaction"] == "eyes"
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.mark_activity(
        ROOM_ID, "msg-1", agent_name="worker", mark="working", on=True
    )
    assert len(calls) == 1


async def test_send_attachment_two_step_upload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/rooms.media/" in request.url.path:
            return httpx.Response(
                200, json={"success": True, "file": {"_id": "file-9"}}
            )
        if "/rooms.mediaConfirm/" in request.url.path:
            return httpx.Response(
                200, json={"success": True, "message": {"_id": "sent-file"}}
            )
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_attachment(
        channel_id=ROOM_ID,
        sender_name="Test Agent",
        filename="note.txt",
        mimetype="text/plain",
        data=b"file body",
        caption="a file",
    )
    assert ref == "sent-file"
    assert len(calls) == 2
    assert "/rooms.media/" in str(calls[0].url)
    assert "/rooms.mediaConfirm/" in str(calls[1].url)


async def test_create_channel() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/channels.create":
            return httpx.Response(
                200, json={"success": True, "channel": {"_id": "new-room"}}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    channel_id = await adapter.create_channel("team-chat", "topic")
    assert channel_id == "new-room"


async def test_retire_channel_archives() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/channels.archive":
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    outcome = await adapter.retire_channel(ROOM_ID)
    assert outcome.outcome == "archived"


async def test_get_channel_type() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/rooms.info":
            return httpx.Response(
                200, json={"success": True, "room": {"t": "p", "name": "secret"}}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    assert await adapter.get_channel_type(ROOM_ID) == "channel_private"


# --- Quiet vs listening -------------------------------------------------------


async def test_quiet_mode_no_websocket() -> None:
    transport, calls = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    adapter.set_listening(False)
    await adapter.start(
        on_message=AsyncMock(),
        on_command=AsyncMock(),
        on_agent_joined=AsyncMock(),
        on_user_joined=AsyncMock(),
        on_app_joined=AsyncMock(),
    )
    assert len(calls) == 0
    assert adapter._ddp_task is None


# --- classify_failure ---------------------------------------------------------


def test_classify_failure() -> None:
    assert RocketChatAdapter.classify_failure(httpx.ConnectError("x")) == "network"
    assert RocketChatAdapter.classify_failure(httpx.TimeoutException("x")) == "network"
    assert (
        RocketChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(401)
            )
        )
        == "auth_failed"
    )
    assert (
        RocketChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(404)
            )
        )
        == "config_invalid"
    )
    assert (
        RocketChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(500)
            )
        )
        == "platform_error"
    )


# --- Registration -------------------------------------------------------------


def test_adapter_registered() -> None:
    from switch_core.bridges.collaboration.platforms import PLATFORMS

    platforms = [p for p in PLATFORMS if p.key == "rocketchat"]
    assert len(platforms) == 1
    p = platforms[0]
    assert p.adapter is RocketChatAdapter
    assert p.config is RocketChatConnectionConfig
