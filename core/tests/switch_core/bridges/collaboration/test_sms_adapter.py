from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any, cast
from urllib.parse import urlencode

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.sms.adapter import (
    SmsAdapter,
    SmsConnectionConfig,
)
from switch_core.bridges.collaboration.sms.chunking import chunk_sms
from switch_core.bridges.collaboration.sms.client import TwilioApiError, TwilioClient

ACCOUNT = "AC" + ("a" * 32)
WEBHOOK = "https://switch.example.com/messaging/bridges/bridge-1/events"


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.downloaded = b"photo"

    async def send_sms(self, *, sender: str, recipient: str, body: str) -> str:
        self.calls.append(("send", (sender, recipient, body)))
        return f"SM{len(self.calls)}"

    async def download(self, url: str) -> tuple[bytes, str | None]:
        self.calls.append(("download", url))
        return self.downloaded, "image/jpeg"


def adapter(*, max_segments: int = 2) -> SmsAdapter:
    value = SmsAdapter(
        config=SmsConnectionConfig(
            account_sid=ACCOUNT,
            auth_token="secret",
            phone_number="+14155550100",
            allowed_numbers=["+14155550101"],
            max_segments_per_reply=max_segments,
        )
    )
    value._client = cast(TwilioClient, FakeClient())
    value.set_webhook_url(WEBHOOK)
    return value


def request(
    values: dict[str, str], *, token: str = "secret", url: str = WEBHOOK
) -> WebhookRequest:
    body = urlencode(values).encode()
    signed = url + "".join(key + value for key, value in sorted(values.items()))
    signature = base64.b64encode(
        hmac.new(token.encode(), signed.encode(), hashlib.sha1).digest()
    ).decode()
    return WebhookRequest(
        method="POST",
        headers={"x-twilio-signature": signature},
        query={},
        body=body,
    )


def inbound(**changes: str) -> dict[str, str]:
    return {
        "MessageSid": "SM123",
        "From": "+14155550101",
        "To": "+14155550100",
        "Body": "hello",
        **changes,
    }


def test_config_validates_account_and_phone_numbers() -> None:
    with pytest.raises(ValidationError):
        SmsConnectionConfig(
            account_sid="bad",
            auth_token="secret",
            phone_number="4155550100",
            allowed_numbers=["+14155550101"],
        )
    with pytest.raises(ValidationError):
        SmsConnectionConfig(
            account_sid=ACCOUNT,
            auth_token="secret",
            phone_number="+14155550100",
            allowed_numbers=["+14155550101", "+14155550101"],
        )


@pytest.mark.parametrize(
    ("text", "maximum", "expected"),
    [
        ("a" * 161, 2, 2),
        ("{" * 81, 2, 2),
        ("🙂" * 36, 2, 2),
    ],
)
def test_chunking_accounts_for_gsm_extension_and_unicode(
    text: str, maximum: int, expected: int
) -> None:
    chunks, truncated = chunk_sms(text, max_segments=maximum)
    assert len(chunks) == expected
    assert not truncated


def test_chunking_caps_cost_and_marks_truncation() -> None:
    chunks, truncated = chunk_sms("word " * 500, max_segments=2)
    assert len(chunks) == 2
    assert truncated
    assert chunks[-1].endswith("[truncated; see Switch]")
    assert all(len(chunk) <= 160 for chunk in chunks)


@pytest.mark.asyncio
async def test_valid_signature_is_checked_against_exact_public_url() -> None:
    value = adapter()
    await value.verify_webhook(request(inbound()))
    with pytest.raises(WebhookAuthenticityError):
        await value.verify_webhook(request(inbound(), url=WEBHOOK + "/wrong"))


@pytest.mark.asyncio
async def test_missing_or_tampered_signature_is_refused() -> None:
    value = adapter()
    unsigned = request(inbound())
    unsigned = WebhookRequest(method="POST", headers={}, query={}, body=unsigned.body)
    with pytest.raises(WebhookAuthenticityError):
        await value.verify_webhook(unsigned)
    tampered = request(inbound())
    tampered = WebhookRequest(
        method="POST",
        headers=tampered.headers,
        query={},
        body=tampered.body + b"x",
    )
    with pytest.raises(WebhookAuthenticityError):
        await value.verify_webhook(tampered)


def test_parse_uses_message_sid_for_multi_pod_deduplication() -> None:
    parsed = adapter().parse_webhook(request(inbound()))
    assert parsed.external_event_id == "SM123"
    assert parsed.payload["From"] == "+14155550101"
    assert not parsed.answers_inline


def test_parse_requires_message_identity_and_route() -> None:
    with pytest.raises(WebhookPayloadError):
        adapter().parse_webhook(request({"Body": "hello"}))


@pytest.mark.asyncio
async def test_allowlisted_inbound_message_is_dispatched() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value.dispatch_event(envelope_type="message", payload=inbound())
    assert messages[0].channel_id == "+14155550101"
    assert messages[0].channel_type == "direct"
    assert messages[0].message_ref == "SM123"


@pytest.mark.asyncio
async def test_unknown_sender_and_wrong_recipient_are_ignored() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value.dispatch_event(
        envelope_type="message", payload=inbound(From="+14155550999")
    )
    await value.dispatch_event(
        envelope_type="message", payload=inbound(To="+14155550999")
    )
    assert messages == []


@pytest.mark.asyncio
async def test_sms_command_routes_to_command_callback() -> None:
    value = adapter()
    commands: list[InboundCommand] = []

    async def on_command(command: InboundCommand) -> None:
        commands.append(command)

    value._on_command = on_command
    await value.dispatch_event(
        envelope_type="message", payload=inbound(Body="!reset @helper")
    )
    assert commands[0].command == "reset"
    assert commands[0].args == "@helper"


@pytest.mark.asyncio
async def test_mms_is_downloaded_and_bounded() -> None:
    value = adapter()
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    payload = inbound(
        NumMedia="1",
        MediaUrl0="https://api.twilio.com/media/photo.jpg",
        MediaContentType0="image/jpeg",
    )
    await value.dispatch_event(envelope_type="message", payload=payload)
    assert messages[0].attachments[0].data == b"photo"
    value.set_max_attachment_bytes(3)
    await value.dispatch_event(envelope_type="message", payload=payload)
    assert "larger" in messages[1].attachment_failures[0].reason


@pytest.mark.asyncio
async def test_outbound_is_allowlisted_split_and_returns_first_sid() -> None:
    value = adapter(max_segments=2)
    ref = await value.send_message("+14155550101", "Helper", "word " * 100)
    assert ref == "SM1"
    fake = cast(FakeClient, value._client)
    sends = [call for call in fake.calls if call[0] == "send"]
    assert len(sends) == 2
    assert sends[0][1][0:2] == ("+14155550100", "+14155550101")
    assert sends[-1][1][2].endswith("[truncated; see Switch]")
    with pytest.raises(BridgeOperationError, match="allow-list"):
        await value.send_message("+14155550999", "Helper", "hello")


@pytest.mark.asyncio
async def test_edits_and_deletes_are_explicitly_unsupported() -> None:
    value = adapter()
    with pytest.raises(BridgeOperationError, match="cannot be edited"):
        await value.update_message("+14155550101", "SM1", "new")
    with pytest.raises(BridgeOperationError, match="cannot be deleted"):
        await value.delete_message("+14155550101", "SM1")


@pytest.mark.asyncio
async def test_client_uses_basic_auth_and_form_encoded_send() -> None:
    seen: list[httpx.Request] = []

    async def handler(http_request: httpx.Request) -> httpx.Response:
        seen.append(http_request)
        return httpx.Response(201, json={"sid": "SMsent"})

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        auth=httpx.BasicAuth(ACCOUNT, "secret"),
    )
    client = TwilioClient(account_sid=ACCOUNT, auth_token="secret", http=http)
    assert (
        await client.send_sms(
            sender="+14155550100", recipient="+14155550101", body="hello"
        )
        == "SMsent"
    )
    assert seen[0].headers["authorization"].startswith("Basic ")
    assert b"From=%2B14155550100" in seen[0].content
    await http.aclose()


@pytest.mark.asyncio
async def test_client_surfaces_twilio_error_message() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Authenticate"})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = TwilioClient(account_sid=ACCOUNT, auth_token="bad", http=http)
    with pytest.raises(TwilioApiError, match="Authenticate"):
        await client.verify_account()
    await http.aclose()
