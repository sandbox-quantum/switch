"""Unit tests for the Lark / Feishu collaboration bridge adapter.

The Lark OpenAPI REST endpoints are mocked at the transport level with
httpx.MockTransport; long-connection events are fed to the adapter as
plain dicts (the SDK serializes its event objects to the same shape).
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from switch_core.bridges.collaboration.lark.adapter import (
    LarkAdapter,
    LarkConnectionConfig,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    InboundCommand,
    InboundMessage,
)

CHAT_ID = "oc_123"
BOT_OPEN_ID = "ou_bot"


def _config(**overrides: Any) -> LarkConnectionConfig:
    return LarkConnectionConfig(app_id="cli_test", app_secret="secret", **overrides)


def _transport(
    handler: Any,
) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(recording), calls


def _token_response() -> httpx.Response:
    return httpx.Response(
        200, json={"code": 0, "tenant_access_token": "t-token", "expire": 7200}
    )


def _adapter(
    transport: httpx.AsyncTransport | None = None,
) -> LarkAdapter:
    adapter = LarkAdapter(config=_config(), transport=transport)
    adapter._tenant_token = "t-token"
    adapter._token_expires_at = 9999999999.0
    adapter._bot_open_id = BOT_OPEN_ID
    adapter._bot_name = "switch-bot"
    return adapter


async def _started(adapter: LarkAdapter) -> dict[str, AsyncMock]:
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


def _event(**message_overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "message_id": "om_1",
        "chat_id": CHAT_ID,
        "chat_type": "group",
        "message_type": "text",
        "content": json.dumps({"text": "Hello world"}),
    }
    message.update(message_overrides)
    return {
        "header": {"event_id": "ev-1", "event_type": "im.message.receive_v1"},
        "event": {
            "sender": {
                "sender_id": {"open_id": "ou_user1"},
                "sender_type": "user",
                "tenant_key": "tenant-1",
            },
            "message": message,
        },
    }


# --- Config ---------------------------------------------------------------


def test_config_defaults_to_feishu() -> None:
    config = _config()
    assert config.api_base_url == "https://open.feishu.cn"


def test_config_invalid_url() -> None:
    with pytest.raises(ValueError, match="api_base_url must use https"):
        LarkConnectionConfig(
            app_id="cli_x", app_secret="s", api_base_url="http://open.feishu.cn"
        )


# --- verify_credentials -----------------------------------------------------


def _patch_http(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.lark.adapter.httpx.AsyncClient", factory
    )


async def test_verify_credentials_success(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["app_id"] == "cli_test"
        return httpx.Response(
            200, json={"code": 0, "app_access_token": "a-token", "expire": 7200}
        )

    _patch_http(monkeypatch, handler)
    await LarkAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_bad_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_http(
        monkeypatch,
        lambda request: httpx.Response(
            200, json={"code": 10003, "msg": "invalid app secret"}
        ),
    )
    with pytest.raises(Exception, match="rejected the credentials"):
        await LarkAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_server_down(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    _patch_http(monkeypatch, handler)
    with pytest.raises(Exception, match="Could not reach the Lark server"):
        await LarkAdapter.verify_credentials(_config().model_dump())


# --- Inbound ----------------------------------------------------------------


async def test_inbound_text_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(_event())
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert isinstance(msg, InboundMessage)
    assert msg.channel_id == CHAT_ID
    assert msg.sender_id == "ou_user1"
    assert msg.content == "Hello world"
    assert msg.message_ref == "om_1"
    assert msg.channel_type == "channel_private"


async def test_inbound_sender_name_resolved() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/contact/v3/users/" in request.url.path:
            return httpx.Response(200, json={"code": 0, "data": {"name": "Alice"}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(_event())
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.sender_name == "Alice"


async def test_inbound_own_app_message_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)
    payload = _event()
    payload["event"]["sender"]["sender_type"] = "app"

    await adapter._process_event(payload)
    callbacks["on_message"].assert_not_called()


async def test_inbound_p2p_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(_event(chat_type="p2p"))
    callbacks["on_message"].assert_not_called()


async def test_inbound_dedup() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(_event())
    callbacks["on_message"].assert_called_once()
    callbacks["on_message"].reset_mock()
    await adapter._process_event(_event())
    callbacks["on_message"].assert_not_called()


async def test_inbound_thread_reply() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(
        _event(thread_id="omt_1", root_id="om_root", parent_id="om_root")
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.root_id == "om_root"


async def test_inbound_command() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(_event(content=json.dumps({"text": "!reset agent"})))
    callbacks["on_command"].assert_called_once()
    cmd = callbacks["on_command"].call_args[0][0]
    assert isinstance(cmd, InboundCommand)
    assert cmd.command == "reset"
    assert cmd.args == "agent"


async def test_inbound_post_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    post = {
        "title": "Report",
        "content": [
            [
                {"tag": "text", "text": "See "},
                {"tag": "a", "text": "docs", "href": "https://example.com"},
            ]
        ],
    }
    await adapter._process_event(_event(message_type="post", content=json.dumps(post)))
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.content == "Report\nSee docs"


async def test_inbound_image_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/resources/" in request.url.path:
            return httpx.Response(
                200, content=b"img-bytes", headers={"content-type": "image/png"}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(
        _event(message_type="image", content=json.dumps({"image_key": "img_1"}))
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert len(msg.attachments) == 1
    att = msg.attachments[0]
    assert isinstance(att, Attachment)
    assert att.data == b"img-bytes"
    assert att.mimetype == "image/png"


async def test_inbound_file_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/resources/" in request.url.path:
            return httpx.Response(
                200, content=b"file-bytes", headers={"content-type": "application/pdf"}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_event(
        _event(
            message_type="file",
            content=json.dumps({"file_key": "file_1", "file_name": "report.pdf"}),
        )
    )
    msg = callbacks["on_message"].call_args[0][0]
    assert len(msg.attachments) == 1
    assert msg.attachments[0].filename == "report.pdf"


# --- Outbound -----------------------------------------------------------------


async def test_send_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open-apis/im/v1/messages":
            assert request.headers["authorization"] == "Bearer t-token"
            return httpx.Response(
                200, json={"code": 0, "data": {"message_id": "om_sent"}}
            )
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=CHAT_ID, sender_name="Test Agent", content="Hello world"
    )
    assert ref == "om_sent"
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["receive_id_type"] == "chat_id"
    assert body["receive_id"] == CHAT_ID
    assert body["msg_type"] == "text"
    assert "Test Agent: Hello world" in json.loads(body["content"])["text"]


async def test_send_message_threaded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/reply" in request.url.path:
            body = json.loads(request.content)
            assert body["reply_in_thread"] is True
            return httpx.Response(
                200, json={"code": 0, "data": {"message_id": "om_reply"}}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=CHAT_ID,
        sender_name="Test Agent",
        content="Reply",
        thread_root_id="om_root",
    )
    assert ref == "om_reply"


async def test_update_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH":
            return httpx.Response(200, json={"code": 0, "data": {}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.update_message(
        channel_id=CHAT_ID, message_ref="om_1", new_content="Edited"
    )
    assert len(calls) == 1
    assert json.loads(calls[0].content)["content"] == '{"text": "Edited"}'


async def test_delete_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(200, json={"code": 0, "data": {}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.delete_message(channel_id=CHAT_ID, message_ref="om_1")
    assert len(calls) == 1


async def test_send_attachment_file() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open-apis/im/v1/files":
            return httpx.Response(200, json={"code": 0, "data": {"file_key": "file_9"}})
        if request.url.path == "/open-apis/im/v1/messages":
            body = json.loads(request.content)
            assert body["msg_type"] == "file"
            return httpx.Response(
                200, json={"code": 0, "data": {"message_id": "om_file"}}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_attachment(
        channel_id=CHAT_ID,
        sender_name="Test Agent",
        filename="report.pdf",
        mimetype="application/pdf",
        data=b"%PDF-1.4",
    )
    assert ref == "om_file"


async def test_create_channel() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/open-apis/im/v1/chats":
            body = json.loads(request.content)
            assert body["name"] == "team-chat"
            assert body["chat_mode"] == "group"
            return httpx.Response(200, json={"code": 0, "data": {"chat_id": "oc_new"}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    assert await adapter.create_channel("team-chat", "topic") == "oc_new"


async def test_retire_channel_deletes_chat() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE" and "/chats/" in request.url.path:
            return httpx.Response(200, json={"code": 0, "data": {}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    outcome = await adapter.retire_channel(CHAT_ID)
    assert outcome.outcome == "deleted"


async def test_get_channel_type() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/chats/" in request.url.path:
            return httpx.Response(200, json={"code": 0, "data": {"chat_mode": "group"}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    assert await adapter.get_channel_type(CHAT_ID) == "channel_private"


# --- Quiet vs listening -------------------------------------------------------


async def test_quiet_mode_no_long_connection() -> None:
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
    assert adapter._ws_thread is None


# --- classify_failure ---------------------------------------------------------


def test_classify_failure() -> None:
    assert LarkAdapter.classify_failure(httpx.ConnectError("x")) == "network"
    assert LarkAdapter.classify_failure(httpx.TimeoutException("x")) == "network"
    assert (
        LarkAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(401)
            )
        )
        == "auth_failed"
    )
    assert (
        LarkAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(404)
            )
        )
        == "config_invalid"
    )
    assert (
        LarkAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(500)
            )
        )
        == "platform_error"
    )


# --- Registration -------------------------------------------------------------


def test_adapter_registered() -> None:
    from switch_core.bridges.collaboration.platforms import PLATFORMS

    platforms = [p for p in PLATFORMS if p.key == "lark"]
    assert len(platforms) == 1
    p = platforms[0]
    assert p.adapter is LarkAdapter
    assert p.config is LarkConnectionConfig
