from __future__ import annotations

import base64
import hashlib
import json
import os
import time

import httpx
import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.lark.adapter import (
    LarkAdapter,
    LarkConnectionConfig,
    _chunks,
    _post_content,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS


def _config(**overrides: str) -> LarkConnectionConfig:
    return LarkConnectionConfig(
        app_id="cli_test",
        app_secret="app-secret",
        verification_token="verify",
        **overrides,
    )


def _encrypted_request(
    *, timestamp: str | None = None, nonce: str = "request-nonce"
) -> WebhookRequest:
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key_text = "encrypt-secret"
    event = {
        "schema": "2.0",
        "header": {
            "token": "verify",
            "event_id": "evt-encrypted",
            "event_type": "im.message.receive_v1",
        },
        "event": {},
    }
    plaintext = json.dumps(event, separators=(",", ":")).encode()
    padder = padding.PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext) + padder.finalize()
    iv = os.urandom(16)
    key = hashlib.sha256(key_text.encode()).digest()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    body = json.dumps(
        {"encrypt": base64.b64encode(iv + ciphertext).decode()},
        separators=(",", ":"),
    ).encode()
    timestamp = timestamp or str(int(time.time()))
    signature = hashlib.sha256(
        (timestamp + nonce + key_text).encode() + body
    ).hexdigest()
    return WebhookRequest(
        "POST",
        {
            "x-lark-request-timestamp": timestamp,
            "x-lark-request-nonce": nonce,
            "x-lark-signature": signature,
        },
        {},
        body,
    )


def test_lark_is_registered_as_a_webhook_platform() -> None:
    registration = next(item for item in PLATFORMS if item.key == "lark")
    assert registration.adapter is LarkAdapter
    assert registration.config is LarkConnectionConfig
    assert LarkAdapter.receives_webhooks
    assert LarkAdapter.keeps_quiet_unless_listening
    assert LarkAdapter.supports_channel_creation


@pytest.mark.asyncio
async def test_webhook_verifies_token_and_reuses_event_id() -> None:
    adapter = LarkAdapter(config=_config())
    body = {
        "schema": "2.0",
        "header": {
            "token": "verify",
            "event_id": "evt-1",
            "event_type": "im.message.receive_v1",
        },
        "event": {},
    }
    request = WebhookRequest("POST", {}, {}, json.dumps(body).encode())
    await adapter.verify_webhook(request)
    parsed = adapter.parse_webhook(request)
    assert parsed.external_event_id == "evt-1"
    assert parsed.envelope_type == "im.message.receive_v1"
    assert parsed.answers_inline is False
    await adapter.stop()


@pytest.mark.asyncio
async def test_webhook_rejects_another_apps_token() -> None:
    adapter = LarkAdapter(config=_config())
    request = WebhookRequest(
        "POST", {}, {}, json.dumps({"token": "wrong", "challenge": "abc"}).encode()
    )
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(request)
    await adapter.stop()


@pytest.mark.asyncio
async def test_encrypted_event_verifies_signature_before_decrypting() -> None:
    adapter = LarkAdapter(config=_config(encrypt_key="encrypt-secret"))
    request = _encrypted_request()
    await adapter.verify_webhook(request)
    parsed = adapter.parse_webhook(request)
    assert parsed.external_event_id == "evt-encrypted"
    assert parsed.envelope_type == "im.message.receive_v1"
    await adapter.stop()


@pytest.mark.asyncio
async def test_encrypted_event_rejects_tampering_and_missing_signature() -> None:
    adapter = LarkAdapter(config=_config(encrypt_key="encrypt-secret"))
    request = _encrypted_request()
    tampered = WebhookRequest(
        request.method,
        request.headers,
        request.query,
        request.body.replace(b'"encrypt":"', b'"encrypt":"A', 1),
    )
    with pytest.raises(WebhookAuthenticityError, match="signature"):
        await adapter.verify_webhook(tampered)
    missing = WebhookRequest(request.method, {}, request.query, request.body)
    with pytest.raises(WebhookAuthenticityError, match="missing its signature"):
        await adapter.verify_webhook(missing)
    await adapter.stop()


@pytest.mark.asyncio
async def test_encrypted_event_rejects_stale_signed_replay() -> None:
    adapter = LarkAdapter(config=_config(encrypt_key="encrypt-secret"))
    stale = _encrypted_request(timestamp=str(int(time.time()) - 8 * 60 * 60 - 1))
    with pytest.raises(WebhookAuthenticityError, match="outside the allowed window"):
        await adapter.verify_webhook(stale)
    await adapter.stop()


@pytest.mark.asyncio
async def test_event_without_stable_id_is_rejected_for_shared_deduplication() -> None:
    adapter = LarkAdapter(config=_config())
    body = {"header": {"token": "verify", "event_type": "unknown"}}
    request = WebhookRequest("POST", {}, {}, json.dumps(body).encode())
    await adapter.verify_webhook(request)
    with pytest.raises(WebhookPayloadError, match="stable event ID"):
        adapter.parse_webhook(request)
    await adapter.stop()


@pytest.mark.asyncio
async def test_malformed_webhook_is_refused() -> None:
    adapter = LarkAdapter(config=_config())
    request = WebhookRequest("POST", {}, {}, b"not-json")
    with pytest.raises(WebhookPayloadError):
        await adapter.verify_webhook(request)
    await adapter.stop()


@pytest.mark.asyncio
async def test_challenge_uses_json_response_body() -> None:
    adapter = LarkAdapter(config=_config())
    body = {"token": "verify", "challenge": "challenge-1"}
    request = WebhookRequest("POST", {}, {}, json.dumps(body).encode())
    await adapter.verify_webhook(request)
    parsed = adapter.parse_webhook(request)
    assert parsed.handshake == '{"challenge": "challenge-1"}'
    await adapter.stop()


@pytest.mark.asyncio
async def test_receive_event_maps_group_and_thread_to_switch_message() -> None:
    adapter = LarkAdapter(config=_config())
    received = []

    async def on_message(message):
        received.append(message)

    adapter.set_listening(False)
    await adapter.start(
        on_message=on_message,
        on_command=lambda _: pytest.fail("ordinary message parsed as a command"),
        on_agent_joined=lambda _: pytest.fail("unexpected agent join"),
        on_user_joined=lambda _: pytest.fail("unexpected user join"),
        on_app_joined=lambda _: pytest.fail("unexpected app join"),
    )
    payload = {
        "event": {
            "sender": {
                "sender_type": "user",
                "sender_id": {"open_id": "ou_user"},
                "name": "Mina",
            },
            "message": {
                "message_id": "om_message",
                "chat_id": "oc_group",
                "chat_type": "group",
                "root_id": "om_root",
                "message_type": "text",
                "content": json.dumps({"text": "hello"}),
            },
        }
    }
    await adapter.dispatch_event(envelope_type="im.message.receive_v1", payload=payload)
    assert len(received) == 1
    assert received[0].channel_id == "oc_group"
    assert received[0].root_id == "om_root"
    assert received[0].content == "hello"
    await adapter.stop()


def test_long_messages_split_at_word_boundaries() -> None:
    chunks = _chunks("word " * 1000, 100)
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert "".join(chunks) == "word " * 1000


@pytest.mark.asyncio
async def test_command_event_is_parsed_as_a_switch_command() -> None:
    adapter = LarkAdapter(config=_config())
    commands = []

    async def on_command(command):
        commands.append(command)

    adapter.set_listening(False)
    await adapter.start(
        on_message=lambda _: pytest.fail("command was sent as an ordinary message"),
        on_command=on_command,
        on_agent_joined=lambda _: pytest.fail("unexpected agent join"),
        on_user_joined=lambda _: pytest.fail("unexpected user join"),
        on_app_joined=lambda _: pytest.fail("unexpected app join"),
    )
    await adapter.dispatch_event(
        envelope_type="im.message.receive_v1",
        payload={
            "event": {
                "sender": {
                    "sender_type": "user",
                    "sender_id": {"open_id": "ou_user"},
                    "name": "Mina",
                },
                "message": {
                    "message_id": "om_command",
                    "chat_id": "oc_chat",
                    "chat_type": "group",
                    "message_type": "text",
                    "content": json.dumps({"text": "!help rooms"}),
                },
            }
        },
    )
    assert commands[0].command == "help"
    assert commands[0].args == "rooms"
    await adapter.stop()


@pytest.mark.asyncio
async def test_outbound_oversize_attachment_is_refused_visibly_without_upload() -> None:
    adapter = LarkAdapter(config=_config())
    adapter.set_max_attachment_bytes(3)
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("tenant_access_token/internal"):
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "tenant-token"}
            )
        return httpx.Response(
            200, json={"code": 0, "data": {"message": {"message_id": "om_notice"}}}
        )

    await adapter._http.aclose()
    adapter._http = httpx.AsyncClient(
        base_url="https://open.larksuite.com", transport=httpx.MockTransport(handler)
    )
    result = await adapter.send_attachment(
        "oc_chat", "Agent", "large.bin", "application/octet-stream", b"four"
    )
    assert result == "om_notice"
    assert all(not request.url.path.endswith("/files") for request in calls)
    await adapter.stop()


@pytest.mark.asyncio
async def test_bad_app_credentials_return_operator_facing_error(monkeypatch) -> None:
    transport = httpx.MockTransport(
        lambda _: httpx.Response(200, json={"code": 10014, "msg": "invalid app secret"})
    )
    original_client = httpx.AsyncClient

    def mock_client(*args, **kwargs):
        return original_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(
        "switch_core.bridges.collaboration.lark.adapter.httpx.AsyncClient", mock_client
    )
    with pytest.raises(BridgeCredentialError, match="invalid app secret"):
        await LarkAdapter.verify_credentials(
            {
                "app_id": "cli_test",
                "app_secret": "wrong",
                "verification_token": "verify",
            }
        )


def test_markdown_is_converted_to_lark_post_format() -> None:
    rendered = json.loads(_post_content("**bold** and [link](https://example.com)"))
    elements = rendered["zh_cn"]["content"][0]
    assert elements[0] == {"tag": "text", "text": "bold", "style": ["bold"]}
    assert elements[2] == {"tag": "a", "text": "link", "href": "https://example.com"}


@pytest.mark.asyncio
async def test_reply_is_sent_in_the_lark_thread() -> None:
    adapter = LarkAdapter(config=_config())
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("tenant_access_token/internal"):
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "tenant-token"}
            )
        return httpx.Response(
            200, json={"code": 0, "data": {"message": {"message_id": "om_reply"}}}
        )

    await adapter._http.aclose()
    adapter._http = httpx.AsyncClient(
        base_url="https://open.larksuite.com", transport=httpx.MockTransport(handler)
    )
    ref = await adapter.send_message("oc_chat", "Agent", "Hello", "om_root")
    assert ref == "om_reply"
    assert calls[-1].url.path == "/open-apis/im/v1/messages/om_root/reply"
    assert json.loads(calls[-1].content)["msg_type"] == "post"
    await adapter.update_message("oc_chat", "om_reply", "Edited")
    await adapter.delete_message("oc_chat", "om_reply")
    assert calls[-2].method == "PATCH"
    assert calls[-2].url.path == "/open-apis/im/v1/messages/om_reply"
    assert calls[-1].method == "DELETE"
    assert calls[-1].url.path == "/open-apis/im/v1/messages/om_reply"
    await adapter.stop()


@pytest.mark.asyncio
async def test_group_creation_and_member_addition_use_lark_chat_apis() -> None:
    adapter = LarkAdapter(config=_config())
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("tenant_access_token/internal"):
            return httpx.Response(
                200, json={"code": 0, "tenant_access_token": "tenant-token"}
            )
        if request.method == "POST" and request.url.path.endswith("/chats"):
            return httpx.Response(200, json={"code": 0, "data": {"chat_id": "oc_new"}})
        return httpx.Response(
            200,
            json={"code": 0, "data": {"invalid_user_id_list": ["ou_missing"]}},
        )

    await adapter._http.aclose()
    adapter._http = httpx.AsyncClient(
        base_url="https://open.larksuite.com", transport=httpx.MockTransport(handler)
    )
    chat_id = await adapter.create_channel("Switch room", "Issue discussion")
    failures = await adapter.add_users_to_channel(
        chat_id, ["Mina", "Missing"], ["ou_mina", "ou_missing"]
    )
    assert chat_id == "oc_new"
    assert failures == ["ou_missing"]
    create = next(request for request in calls if request.url.path.endswith("/chats"))
    assert json.loads(create.content)["chat_mode"] == "group"
    assert json.loads(create.content)["chat_type"] == "public"
    add_members = calls[-1]
    assert add_members.url.path == "/open-apis/im/v1/chats/oc_new/members"
    assert json.loads(add_members.content)["id_list"] == ["ou_mina", "ou_missing"]
    await adapter.stop()
