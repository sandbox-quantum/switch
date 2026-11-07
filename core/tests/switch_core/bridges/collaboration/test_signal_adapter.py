"""Unit tests for the Signal collaboration bridge adapter.

The signal-cli HTTP API is mocked at the transport level with
httpx.MockTransport.
"""

from __future__ import annotations

import base64
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
from switch_core.bridges.collaboration.signal.adapter import (
    SignalAdapter,
    SignalConnectionConfig,
    SignalRpcError,
)

GROUP_ID = "Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI="
ACCOUNT = "+1234567890"


def _config(**overrides: Any) -> SignalConnectionConfig:
    return SignalConnectionConfig(
        daemon_url="http://localhost:8080", account=ACCOUNT, **overrides
    )


def _transport(
    handler: Any,
) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.MockTransport(recording), calls


def _adapter(
    transport: httpx.AsyncTransport | None = None,
) -> SignalAdapter:
    return SignalAdapter(config=_config(), transport=transport)


async def _started(adapter: SignalAdapter) -> dict[str, AsyncMock]:
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


def _envelope(message: str, **extra: Any) -> dict[str, Any]:
    data_message: dict[str, Any] = {
        "timestamp": 1699999999123,
        "message": message,
        "groupInfo": {"groupId": GROUP_ID, "groupName": "Test Group"},
    }
    data_message.update(extra)
    return {
        "source": "+1987654321",
        "sourceNumber": "+1987654321",
        "sourceUuid": "aaa-bbb-ccc",
        "sourceName": "Alice",
        "timestamp": 1699999999123,
        "dataMessage": data_message,
    }


# --- Config ---------------------------------------------------------------


def test_config_valid() -> None:
    config = _config()
    assert config.daemon_url == "http://localhost:8080"
    assert config.account == ACCOUNT


def test_config_invalid_url() -> None:
    with pytest.raises(ValueError, match="daemon_url must use http or https"):
        SignalConnectionConfig(daemon_url="ftp://localhost:8080", account="+123")


def test_config_invalid_account() -> None:
    with pytest.raises(ValueError, match="account must be a phone number"):
        SignalConnectionConfig(daemon_url="http://localhost:8080", account="nope")


def test_config_password_requires_username() -> None:
    with pytest.raises(
        ValueError, match="username and password must be provided together"
    ):
        SignalConnectionConfig(
            daemon_url="http://localhost", account=ACCOUNT, password="secret"
        )


# --- verify_credentials -----------------------------------------------------


def _patch_http(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    calls: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    transport = httpx.MockTransport(recording)
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.signal.adapter.httpx.AsyncClient", factory
    )
    return calls


async def test_verify_credentials_success_multi_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/check":
            return httpx.Response(200)
        body = json.loads(request.content)
        if body["method"] == "listAccounts":
            return httpx.Response(
                200,
                json={
                    "result": [
                        {"number": ACCOUNT, "aci": "aci-123"},
                        {"number": "+1987654321", "aci": "aci-456"},
                    ]
                },
            )
        return httpx.Response(404)

    _patch_http(monkeypatch, handler)
    await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_wrong_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/check":
            return httpx.Response(200)
        return httpx.Response(
            200, json={"result": [{"number": "+1111111111", "aci": "aci-999"}]}
        )

    _patch_http(monkeypatch, handler)
    config = SignalConnectionConfig(
        daemon_url="http://localhost:8080", account="+9999999999"
    )
    with pytest.raises(Exception, match="not registered on the signal-cli daemon"):
        await SignalAdapter.verify_credentials(config.model_dump())


async def test_verify_credentials_single_account_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/check":
            return httpx.Response(200)
        return httpx.Response(
            400,
            json={
                "jsonrpc": "2.0",
                "id": "1",
                "error": {"code": -32601, "message": "Method not found"},
            },
        )

    _patch_http(monkeypatch, handler)
    await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_daemon_down(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused")

    _patch_http(monkeypatch, handler)
    with pytest.raises(Exception, match="Could not reach the signal-cli daemon"):
        await SignalAdapter.verify_credentials(_config().model_dump())


async def test_verify_credentials_proxy_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/check":
            if request.headers.get("authorization") != "Basic c2lnbmFsOnNlY3JldA==":
                return httpx.Response(401)
            return httpx.Response(200)
        return httpx.Response(
            200, json={"result": [{"number": ACCOUNT, "aci": "aci-123"}]}
        )

    _patch_http(monkeypatch, handler)
    config = SignalConnectionConfig(
        daemon_url="http://localhost:8080",
        account=ACCOUNT,
        username="signal",
        password="secret",
    )
    await SignalAdapter.verify_credentials(config.model_dump())


# --- Inbound ----------------------------------------------------------------


async def test_inbound_group_message() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_envelope(
        _envelope(
            "Hello world",
            quote={
                "id": 1699999999000,
                "author": "+1987654321",
                "authorNumber": "+1987654321",
                "authorUuid": "aaa-bbb-ccc",
                "text": "Quoted message",
            },
        )
    )
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert isinstance(msg, InboundMessage)
    assert msg.channel_id == GROUP_ID
    assert msg.sender_id == "aaa-bbb-ccc"
    assert msg.sender_name == "Alice"
    assert msg.content == "Hello world"
    assert msg.message_ref == f"{GROUP_ID}:1699999999123:aaa-bbb-ccc"
    assert msg.root_id == f"{GROUP_ID}:1699999999000:+1987654321"
    assert msg.channel_name == "Test Group"
    assert msg.channel_type == "channel_private"


async def test_inbound_dedup() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)
    envelope = _envelope("Hello")

    await adapter._process_envelope(envelope)
    callbacks["on_message"].assert_called_once()
    callbacks["on_message"].reset_mock()
    await adapter._process_envelope(envelope)
    callbacks["on_message"].assert_not_called()


async def test_inbound_own_message_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)
    envelope = _envelope("My own message")
    envelope["sourceNumber"] = ACCOUNT
    envelope["sourceUuid"] = ACCOUNT

    await adapter._process_envelope(envelope)
    callbacks["on_message"].assert_not_called()


async def test_inbound_dm_skipped() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)
    envelope = _envelope("Direct message")
    del envelope["dataMessage"]["groupInfo"]

    await adapter._process_envelope(envelope)
    callbacks["on_message"].assert_not_called()


async def test_inbound_command() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_envelope(_envelope("!reset agent"))
    callbacks["on_command"].assert_called_once()
    cmd = callbacks["on_command"].call_args[0][0]
    assert isinstance(cmd, InboundCommand)
    assert cmd.command == "reset"
    assert cmd.args == "agent"
    assert cmd.channel_id == GROUP_ID


async def test_inbound_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "getAttachment":
            return httpx.Response(
                200,
                json={"result": {"data": base64.b64encode(b"test content").decode()}},
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_envelope(
        _envelope(
            "Here's a file",
            attachments=[
                {
                    "contentType": "text/plain",
                    "filename": "test.txt",
                    "id": "att-123",
                    "size": 100,
                }
            ],
        )
    )
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert len(msg.attachments) == 1
    att = msg.attachments[0]
    assert isinstance(att, Attachment)
    assert att.filename == "test.txt"
    assert att.mimetype == "text/plain"
    assert att.data == b"test content"


async def test_inbound_oversize_attachment() -> None:
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(transport)
    callbacks = await _started(adapter)

    await adapter._process_envelope(
        _envelope(
            "A file",
            attachments=[
                {
                    "contentType": "application/octet-stream",
                    "filename": "huge.bin",
                    "id": "att-123",
                    "size": 100 * 1024 * 1024,
                }
            ],
        )
    )
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert msg.attachments == []
    assert len(msg.attachment_failures) == 1
    assert msg.attachment_failures[0].filename == "huge.bin"
    assert "exceeds maximum size" in msg.attachment_failures[0].reason


# --- Outbound ---------------------------------------------------------------


async def test_send_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "send":
            return httpx.Response(200, json={"result": {"timestamp": 1699999999123}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=GROUP_ID, sender_name="Test Agent", content="Hello world"
    )
    assert ref == f"{GROUP_ID}:1699999999123:{ACCOUNT}"
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["method"] == "send"
    assert body["params"]["groupId"] == GROUP_ID
    assert "Test Agent: Hello world" in body["params"]["message"]


async def test_send_message_quote_reply() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "send":
            assert body["params"]["quoteTimestamp"] == 1699999999000
            assert body["params"]["quoteAuthor"] == "+1987654321"
            return httpx.Response(200, json={"result": {"timestamp": 1699999999200}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_message(
        channel_id=GROUP_ID,
        sender_name="Test Agent",
        content="Reply",
        thread_root_id=f"{GROUP_ID}:1699999999000:+1987654321",
    )
    assert ref == f"{GROUP_ID}:1699999999200:{ACCOUNT}"


async def test_send_attachment() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "send":
            assert "attachments" in body["params"]
            assert len(body["params"]["attachments"]) == 1
            assert (
                "data:text/plain;filename=test.txt;base64,"
                in body["params"]["attachments"][0]
            )
            return httpx.Response(200, json={"result": {"timestamp": 1699999999300}})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(transport)

    ref = await adapter.send_attachment(
        channel_id=GROUP_ID,
        sender_name="Test Agent",
        filename="test.txt",
        mimetype="text/plain",
        data=b"test content",
        caption="Here's a file",
    )
    assert ref == f"{GROUP_ID}:1699999999300:{ACCOUNT}"


async def test_update_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "send" and "editTimestamp" in body["params"]:
            assert body["params"]["editTimestamp"] == 1699999999123
            return httpx.Response(200, json={"result": {"timestamp": 1699999999400}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.update_message(
        channel_id=GROUP_ID,
        message_ref=f"{GROUP_ID}:1699999999123:{ACCOUNT}",
        new_content="Edited message",
    )
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["method"] == "send"
    assert body["params"]["editTimestamp"] == 1699999999123
    assert body["params"]["message"] == "Edited message"


async def test_delete_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "remoteDelete":
            assert body["params"]["targetTimestamp"] == 1699999999123
            return httpx.Response(200, json={"result": {"timestamp": 1699999999400}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.delete_message(
        channel_id=GROUP_ID, message_ref=f"{GROUP_ID}:1699999999123:{ACCOUNT}"
    )
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["method"] == "remoteDelete"
    assert body["params"]["targetTimestamp"] == 1699999999123


async def test_send_typing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body["method"] == "sendTyping":
            assert body["params"]["stop"] is True
            return httpx.Response(200, json={"result": {}})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(transport)

    await adapter.send_typing(GROUP_ID, "Test Agent", False)
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert body["params"]["stop"] is True


def test_render_outbound_strips_markdown() -> None:
    adapter = _adapter()
    assert adapter._render_outbound("**bold** and `code`") == "bold and code"
    assert adapter._render_outbound("[label](https://example.com)") == (
        "label (https://example.com)"
    )


# --- Quiet vs listening -------------------------------------------------------


async def test_quiet_mode_no_sse() -> None:
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
    assert adapter._sse_task is None


# --- classify_failure ---------------------------------------------------------


def test_classify_failure() -> None:
    assert SignalAdapter.classify_failure(httpx.ConnectError("x")) == "network"
    assert SignalAdapter.classify_failure(httpx.TimeoutException("x")) == "network"
    assert (
        SignalAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(401)
            )
        )
        == "auth_failed"
    )
    assert (
        SignalAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(404)
            )
        )
        == "config_invalid"
    )
    assert (
        SignalAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(500)
            )
        )
        == "platform_error"
    )
    assert (
        SignalAdapter.classify_failure(SignalRpcError(-32602, "bad account"))
        == "config_invalid"
    )
    assert (
        SignalAdapter.classify_failure(SignalRpcError(-32601, "not found"))
        == "platform_error"
    )
    assert (
        SignalAdapter.classify_failure(json.JSONDecodeError("msg", "doc", 0))
        == "platform_error"
    )


# --- Registration -------------------------------------------------------------


def test_adapter_registered() -> None:
    from switch_core.bridges.collaboration.platforms import PLATFORMS

    signal_platforms = [p for p in PLATFORMS if p.key == "signal"]
    assert len(signal_platforms) == 1
    p = signal_platforms[0]
    assert p.adapter is SignalAdapter
    assert p.config is SignalConnectionConfig
