"""The SMS (Twilio) adapter against a stand-in for Twilio's REST API."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.sms.adapter import (
    SIGNATURE_HEADER,
    SmsAdapter,
    SmsConnectionConfig,
    TwilioError,
    bounded,
    plain,
    signature,
)

SID = "AC" + "0" * 32
TOKEN = "f" * 32
NUMBER = "+14155550100"
ADA = "+447700900123"
URL = "https://switch.example.test/messaging/bridges/b1/events"


class FakeTwilio:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, str]]] = []
        self.numbers = [{"sid": "PN1", "phone_number": NUMBER}]

    def handle(self, request: httpx.Request) -> httpx.Response:
        form = dict(parse_qsl(request.content.decode())) if request.content else {}
        self.calls.append((request.method, request.url.path, form))
        if request.headers.get("authorization", "").split(" ")[-1] == "":
            return httpx.Response(401, json={"message": "Authenticate"})
        path = request.url.path
        if path.endswith("/IncomingPhoneNumbers.json"):
            return httpx.Response(200, json={"incoming_phone_numbers": self.numbers})
        if path.endswith("/Messages.json"):
            if form.get("To") == "+15005550001":
                return httpx.Response(400, json={"message": "invalid To number"})
            return httpx.Response(201, json={"sid": "SM-out"})
        return httpx.Response(200, json={})


def _config(**overrides: Any) -> SmsConnectionConfig:
    return SmsConnectionConfig(
        **{"account_sid": SID, "auth_token": TOKEN, "phone_number": NUMBER, **overrides}
    )


@pytest.fixture
def twilio() -> FakeTwilio:
    return FakeTwilio()


async def _adapter(twilio: FakeTwilio, **overrides: Any) -> SmsAdapter:
    adapter = SmsAdapter(config=_config(**overrides))
    adapter._http = httpx.AsyncClient(
        transport=httpx.MockTransport(twilio.handle), auth=(SID, TOKEN)
    )
    received: list[Any] = []

    async def keep(item: Any) -> None:
        received.append(item)

    adapter.set_webhook_url(URL)
    await adapter.start(keep, keep, keep, keep, keep)
    adapter.received = received  # type: ignore[attr-defined]
    return adapter


def _text(body: str, sender: str = ADA, sid: str = "SM1") -> dict[str, str]:
    return {"MessageSid": sid, "From": sender, "To": NUMBER, "Body": body}


def _request(params: dict[str, str], token: str = TOKEN) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: signature(token, URL, params)},
        query={},
        body=urlencode(params).encode(),
    )


@pytest.mark.parametrize(
    ("field", "value", "says"),
    [
        ("account_sid", "AB123", "Account SID"),
        ("auth_token", "secret", "Auth Token"),
        ("phone_number", "4155550100", "international form"),
        ("allowed_numbers", "+1415, nope", "international form"),
        ("max_segments", 0, "max_segments"),
    ],
)
def test_a_config_it_cannot_use_is_refused(field: str, value: Any, says: str) -> None:
    with pytest.raises(ValidationError, match=says):
        _config(**{field: value})


def test_a_number_is_taken_with_spaces_and_dashes() -> None:
    assert _config(phone_number="+1 (415) 555-0100").phone_number == NUMBER


async def test_start_points_the_number_at_this_bridge(twilio: FakeTwilio) -> None:
    await _adapter(twilio)
    [update] = [f for m, p, f in twilio.calls if p.endswith("/PN1.json")]
    assert update == {"SmsUrl": URL, "SmsMethod": "POST"}


async def test_a_number_the_account_does_not_have_is_refused(
    twilio: FakeTwilio,
) -> None:
    twilio.numbers = []
    with pytest.raises(BridgeCredentialError, match="not one of this account"):
        await _adapter(twilio)


async def test_a_signed_text_is_taken_and_another_token_refused(
    twilio: FakeTwilio,
) -> None:
    adapter = await _adapter(twilio)
    await adapter.verify_webhook(_request(_text("hi")))
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_request(_text("hi"), token="e" * 32))


async def test_a_retried_text_carries_the_same_event_id(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio)
    first = adapter.parse_webhook(_request(_text("hi")))
    assert (
        first.external_event_id
        == adapter.parse_webhook(_request(_text("hi"))).external_event_id
    )
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(_request({"Body": "no sid"}))


async def test_a_text_is_a_direct_room_per_number(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio)
    await adapter.dispatch_event(envelope_type="sms", payload=_text("@coder status?"))
    [message] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(message, InboundMessage)
    assert (message.channel_id, message.channel_type, message.sender_id) == (
        ADA,
        "direct",
        ADA,
    )
    assert (message.content, message.message_ref) == ("@coder status?", "SM1")


async def test_a_bang_command(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio)
    await adapter.dispatch_event(envelope_type="sms", payload=_text("!help me"))
    [command] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(command, InboundCommand) and (command.command, command.args) == (
        "help",
        "me",
    )


async def test_only_allowed_numbers_reach_a_room(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio, allowed_numbers="+15550000000")
    await adapter.dispatch_event(envelope_type="sms", payload=_text("hi"))
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_reply_is_plain_text_from_the_number(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio)
    await adapter.send_message(
        ADA, "coder", adapter.translate_outbound("**done**, see [log](https://x.test)")
    )
    [sent] = [f for m, p, f in twilio.calls if p.endswith("/Messages.json")]
    assert sent == {
        "To": ADA,
        "From": NUMBER,
        "Body": "coder: done, see log (https://x.test)",
    }
    with pytest.raises(BridgeOperationError, match="invalid To number"):
        await adapter.send_message("+15005550001", "coder", "x")


def test_a_long_reply_is_cut_to_its_segments_and_says_so() -> None:
    text = "x" * 2000
    cut = bounded(text, 3)
    assert len(cut) <= 3 * 153 and cut.endswith("more characters]")
    assert bounded("short", 1) == "short"
    assert len(bounded("é" * 500, 2)) <= 2 * 67


def test_markdown_reads_as_a_text() -> None:
    assert (
        plain("# Title\n**bold** `code`\n```py\nx = 1\n```")
        == "Title\nbold code\nx = 1"
    )


async def test_there_is_no_group_to_create(twilio: FakeTwilio) -> None:
    adapter = await _adapter(twilio)
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("room", "topic")


def test_failures_are_classified() -> None:
    assert SmsAdapter.classify_failure(TwilioError(401, "no")) == "auth_failed"
    assert SmsAdapter.classify_failure(TwilioError(500, "no")) == "platform_error"
    assert SmsAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert SmsAdapter.claimed_workspace({"phone_number": NUMBER}) == f"sms {NUMBER}"
