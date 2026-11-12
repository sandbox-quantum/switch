"""Unit tests for the Google Chat collaboration bridge adapter.

The Chat API is mocked at the transport level with httpx.MockTransport;
webhook requests are built and signed with a throwaway RSA key generated
per test (no real credentials anywhere).
"""

from __future__ import annotations

import json
import time
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from switch_core.bridges.collaboration.google_chat.adapter import (
    GoogleChatAdapter,
    GoogleChatConnectionConfig,
)
from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
    WebhookVerificationUnavailable,
)
from switch_core.bridges.collaboration.models import (
    Attachment,
    InboundCommand,
    InboundMessage,
)

SPACE = "spaces/AAAA"
CHAT_ISSUER = "chat@system.gserviceaccount.com"
WEBHOOK_URL = "https://example.com/messaging/bridges/bridge-1/events"


def _keypair() -> tuple[str, str, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        private_key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return private_pem, public_pem, "test-kid"


def _config(private_pem: str, **overrides: Any) -> GoogleChatConnectionConfig:
    return GoogleChatConnectionConfig(
        service_account_email="chat-app@project.iam.gserviceaccount.com",
        service_account_private_key=private_pem,
        **overrides,
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
    private_pem: str,
    transport: httpx.AsyncTransport | None = None,
    **config_overrides: Any,
) -> GoogleChatAdapter:
    adapter = GoogleChatAdapter(
        config=_config(private_pem, **config_overrides), transport=transport
    )
    adapter._access_token = "g-token"
    adapter._token_expires_at = 9999999999.0
    adapter.set_webhook_url(WEBHOOK_URL)
    return adapter


async def _started(adapter: GoogleChatAdapter) -> dict[str, AsyncMock]:
    callbacks = {
        "on_message": AsyncMock(),
        "on_command": AsyncMock(),
        "on_agent_joined": AsyncMock(),
        "on_user_joined": AsyncMock(),
        "on_app_joined": AsyncMock(),
    }
    await adapter.start(**callbacks)  # type: ignore[arg-type]
    return callbacks


def _message_payload(**message_overrides: Any) -> dict[str, Any]:
    message: dict[str, Any] = {
        "name": f"{SPACE}/messages/msg-1",
        "sender": {"name": "users/user-1", "displayName": "Alice", "type": "USER"},
        "text": "Hello world",
        "thread": {"threadKey": "thread-1"},
    }
    message.update(message_overrides)
    return {
        "type": "MESSAGE",
        "eventTime": "2026-01-01T00:00:00Z",
        "space": {"name": SPACE, "displayName": "Team", "type": "ROOM"},
        "user": {"name": "users/user-1", "displayName": "Alice", "type": "USER"},
        "message": message,
    }


def _webhook_request(payload: dict[str, Any], token: str) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={"authorization": f"Bearer {token}"},
        query={},
        body=json.dumps(payload).encode(),
    )


def _sign(
    private_pem: str,
    kid: str,
    *,
    audience: str,
    issuer: str,
    email: str | None = None,
) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + 3600,
    }
    if email is not None:
        claims["email"] = email
    return jwt.encode(claims, private_pem, algorithm="RS256", headers={"kid": kid})


# --- Config ---------------------------------------------------------------


def test_config_valid() -> None:
    private_pem, _, _ = _keypair()
    config = _config(private_pem)
    assert config.authentication_audience == "endpoint_url"
    assert config.project_number is None


def test_config_project_number_required() -> None:
    private_pem, _, _ = _keypair()
    with pytest.raises(ValueError, match="project_number is required"):
        _config(private_pem, authentication_audience="project_number")


def test_config_project_number_forbidden_in_endpoint_mode() -> None:
    private_pem, _, _ = _keypair()
    with pytest.raises(ValueError, match="project_number must be omitted"):
        _config(private_pem, project_number="12345")


def test_config_private_key_must_be_pem() -> None:
    with pytest.raises(ValueError, match="PEM private key"):
        GoogleChatConnectionConfig(
            service_account_email="a@b.iam.gserviceaccount.com",
            service_account_private_key="not-a-key",
        )


# --- verify_credentials -----------------------------------------------------


def _patch_token_http(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.google_chat.adapter.httpx.AsyncClient",
        factory,
    )


async def test_verify_credentials_success(monkeypatch: pytest.MonkeyPatch) -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        assert "assertion" in request.content.decode()
        return httpx.Response(200, json={"access_token": "g-token", "expires_in": 3600})

    _patch_token_http(monkeypatch, handler)
    await GoogleChatAdapter.verify_credentials(_config(private_pem).model_dump())


async def test_verify_credentials_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    private_pem, _, _ = _keypair()
    _patch_token_http(
        monkeypatch,
        lambda request: httpx.Response(400, json={"error": "invalid_grant"}),
    )
    with pytest.raises(Exception, match="rejected the service account credentials"):
        await GoogleChatAdapter.verify_credentials(_config(private_pem).model_dump())


# --- Webhook verification -----------------------------------------------------


async def test_verify_webhook_endpoint_mode_accepts_valid_token() -> None:
    private_pem, public_pem, kid = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={kid: public_pem})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    token = _sign(
        private_pem,
        kid,
        audience=WEBHOOK_URL,
        issuer="https://accounts.google.com",
        email=CHAT_ISSUER,
    )
    await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_rejects_wrong_audience() -> None:
    private_pem, public_pem, kid = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={kid: public_pem})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    token = _sign(
        private_pem,
        kid,
        audience="https://evil.example.com/hook",
        issuer="https://accounts.google.com",
        email=CHAT_ISSUER,
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_rejects_wrong_email() -> None:
    private_pem, public_pem, kid = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={kid: public_pem})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    token = _sign(
        private_pem,
        kid,
        audience=WEBHOOK_URL,
        issuer="https://accounts.google.com",
        email="attacker@example.com",
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_rejects_bad_signature() -> None:
    private_pem, public_pem, kid = _keypair()
    other_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={kid: public_pem})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    token = _sign(
        other_pem,
        kid,
        audience=WEBHOOK_URL,
        issuer="https://accounts.google.com",
        email=CHAT_ISSUER,
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_certs_unavailable_is_unavailable() -> None:
    private_pem, _, kid = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="oops")

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    token = _sign(
        private_pem,
        kid,
        audience=WEBHOOK_URL,
        issuer="https://accounts.google.com",
        email=CHAT_ISSUER,
    )
    with pytest.raises(WebhookVerificationUnavailable):
        await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_project_number_mode() -> None:
    private_pem, public_pem, kid = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={kid: public_pem})

    transport, _ = _transport(handler)
    adapter = _adapter(
        private_pem,
        transport,
        authentication_audience="project_number",
        project_number="987654321",
    )
    token = _sign(private_pem, kid, audience="987654321", issuer=CHAT_ISSUER)
    await adapter.verify_webhook(_webhook_request(_message_payload(), token))


async def test_verify_webhook_missing_bearer() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    request = WebhookRequest(method="POST", headers={}, query={}, body=b"{}")
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(request)


# --- Webhook parsing and dispatch ---------------------------------------------


async def test_parse_webhook_message() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    payload = _message_payload()
    parsed = adapter.parse_webhook(_webhook_request(payload, "token"))
    assert parsed.envelope_type == "MESSAGE"
    assert parsed.external_event_id == f"{SPACE}/messages/msg-1"
    assert parsed.answers_inline is False
    assert parsed.payload == payload


async def test_parse_webhook_malformed() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    request = WebhookRequest(method="POST", headers={}, query={}, body=b"not json")
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(request)


async def test_dispatch_message() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=_message_payload())
    callbacks["on_message"].assert_called_once()
    msg = callbacks["on_message"].call_args[0][0]
    assert isinstance(msg, InboundMessage)
    assert msg.channel_id == SPACE
    assert msg.sender_id == "users/user-1"
    assert msg.sender_name == "Alice"
    assert msg.content == "Hello world"
    assert msg.message_ref == f"{SPACE}/messages/msg-1"
    assert msg.root_id == "thread-1"
    assert msg.channel_type == "channel_private"


async def test_dispatch_dm_skipped() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)
    payload = _message_payload()
    payload["space"]["type"] = "DM"

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)
    callbacks["on_message"].assert_not_called()


async def test_dispatch_bot_sender_skipped() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)
    payload = _message_payload()
    payload["message"]["sender"]["type"] = "BOT"

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)
    callbacks["on_message"].assert_not_called()


async def test_dispatch_dedup() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=_message_payload())
    callbacks["on_message"].assert_called_once()
    callbacks["on_message"].reset_mock()
    await adapter.dispatch_event(envelope_type="MESSAGE", payload=_message_payload())
    callbacks["on_message"].assert_not_called()


async def test_dispatch_command() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)
    payload = _message_payload()
    payload["message"]["text"] = "!reset agent"

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)
    callbacks["on_command"].assert_called_once()
    cmd = callbacks["on_command"].call_args[0][0]
    assert isinstance(cmd, InboundCommand)
    assert cmd.command == "reset"
    assert cmd.args == "agent"


async def test_dispatch_attachment() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if "attachments/" in request.url.path:
            return httpx.Response(
                200, content=b"file-bytes", headers={"content-type": "text/plain"}
            )
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)
    payload = _message_payload()
    payload["message"]["attachment"] = [
        {
            "attachmentRef": {"resourceName": f"{SPACE}/attachments/att-1"},
            "contentType": "text/plain",
        }
    ]

    await adapter.dispatch_event(envelope_type="MESSAGE", payload=payload)
    msg = callbacks["on_message"].call_args[0][0]
    assert len(msg.attachments) == 1
    assert isinstance(msg.attachments[0], Attachment)
    assert msg.attachments[0].data == b"file-bytes"


async def test_dispatch_added_to_space() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = _adapter(private_pem, transport)
    callbacks = await _started(adapter)

    await adapter.dispatch_event(
        envelope_type="ADDED_TO_SPACE",
        payload={
            "type": "ADDED_TO_SPACE",
            "space": {"name": SPACE, "displayName": "Team", "type": "ROOM"},
        },
    )
    callbacks["on_app_joined"].assert_called_once()
    join = callbacks["on_app_joined"].call_args[0][0]
    assert join.channel_id == SPACE
    assert join.channel_name == "Team"


async def test_start_requires_webhook_url() -> None:
    private_pem, _, _ = _keypair()
    transport, _ = _transport(lambda request: httpx.Response(404))
    adapter = GoogleChatAdapter(config=_config(private_pem), transport=transport)
    with pytest.raises(Exception, match="MESSAGING_PUBLIC_URL"):
        await adapter.start(
            on_message=AsyncMock(),
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )


# --- Outbound -----------------------------------------------------------------


async def test_send_message() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            assert request.headers["authorization"] == "Bearer g-token"
            return httpx.Response(200, json={"name": f"{SPACE}/messages/sent-1"})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(private_pem, transport)

    ref = await adapter.send_message(
        channel_id=SPACE, sender_name="Test Agent", content="Hello world"
    )
    assert ref == f"{SPACE}/messages/sent-1"
    assert len(calls) == 1
    body = json.loads(calls[0].content)
    assert "Test Agent: Hello world" in body["text"]
    assert "threadKey" not in body


async def test_send_message_threaded() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["threadKey"] == "thread-1"
        return httpx.Response(200, json={"name": f"{SPACE}/messages/sent-2"})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)

    ref = await adapter.send_message(
        channel_id=SPACE,
        sender_name="Test Agent",
        content="Reply",
        thread_root_id="thread-1",
    )
    assert ref == f"{SPACE}/messages/sent-2"


async def test_update_message() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH":
            assert request.url.params["updateMask"] == "text"
            return httpx.Response(200, json={"name": f"{SPACE}/messages/msg-1"})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(private_pem, transport)

    await adapter.update_message(
        channel_id=SPACE, message_ref=f"{SPACE}/messages/msg-1", new_content="Edited"
    )
    assert len(calls) == 1
    assert json.loads(calls[0].content)["text"] == "Edited"


async def test_delete_message() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "DELETE":
            return httpx.Response(204, json={})
        return httpx.Response(404)

    transport, calls = _transport(handler)
    adapter = _adapter(private_pem, transport)

    await adapter.delete_message(
        channel_id=SPACE, message_ref=f"{SPACE}/messages/msg-1"
    )
    assert len(calls) == 1


async def test_send_attachment() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if "/attachments" in request.url.path and "upload" in str(request.url):
            return httpx.Response(
                200,
                json={"attachmentRef": {"resourceName": f"{SPACE}/attachments/att-9"}},
            )
        if request.url.path.endswith("/messages"):
            body = json.loads(request.content)
            assert (
                body["attachment"][0]["attachmentRef"]["resourceName"]
                == f"{SPACE}/attachments/att-9"
            )
            return httpx.Response(200, json={"name": f"{SPACE}/messages/sent-9"})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)

    ref = await adapter.send_attachment(
        channel_id=SPACE,
        sender_name="Test Agent",
        filename="report.txt",
        mimetype="text/plain",
        data=b"file body",
    )
    assert ref == f"{SPACE}/messages/sent-9"


async def test_create_space() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/spaces"):
            body = json.loads(request.content)
            assert body["displayName"] == "team-chat"
            assert body["spaceType"] == "ROOM"
            return httpx.Response(200, json={"name": "spaces/NEW"})
        return httpx.Response(404)

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)

    assert await adapter.create_channel("team-chat", "topic") == "spaces/NEW"


async def test_get_channel_type() -> None:
    private_pem, _, _ = _keypair()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"name": SPACE, "spaceType": "ROOM"})

    transport, _ = _transport(handler)
    adapter = _adapter(private_pem, transport)

    assert await adapter.get_channel_type(SPACE) == "channel_private"


# --- classify_failure ---------------------------------------------------------


def test_classify_failure() -> None:
    assert GoogleChatAdapter.classify_failure(httpx.ConnectError("x")) == "network"
    assert GoogleChatAdapter.classify_failure(httpx.TimeoutException("x")) == "network"
    assert (
        GoogleChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(401)
            )
        )
        == "auth_failed"
    )
    assert (
        GoogleChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(404)
            )
        )
        == "config_invalid"
    )
    assert (
        GoogleChatAdapter.classify_failure(
            httpx.HTTPStatusError(
                "x", request=MagicMock(), response=httpx.Response(500)
            )
        )
        == "platform_error"
    )


# --- Registration -------------------------------------------------------------


def test_adapter_registered() -> None:
    from switch_core.bridges.collaboration.platforms import PLATFORMS

    platforms = [p for p in PLATFORMS if p.key == "google_chat"]
    assert len(platforms) == 1
    p = platforms[0]
    assert p.adapter is GoogleChatAdapter
    assert p.config is GoogleChatConnectionConfig
