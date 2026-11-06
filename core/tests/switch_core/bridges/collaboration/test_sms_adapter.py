"""The SMS (Twilio) adapter: its config, Twilio's signature, cost limits, and
what it sends and receives, with Twilio's REST API mocked at the transport."""

from __future__ import annotations

from collections.abc import Iterator
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
    MAX_BODY,
    SIGNATURE_HEADER,
    TRUNCATION_NOTE,
    SmsAdapter,
    SmsConnectionConfig,
    cap_to_segments,
    segment_count,
    split_body,
    twilio_signature,
)

SID = "AC" + "0" * 32
TOKEN = "test-auth-token"
NUMBER = "+15005550006"
ALICE = "+919812345678"
STRANGER = "+447700900123"
HOOK = "https://switch.example/messaging/bridges/b-1/events"


def _config(**overrides: Any) -> SmsConnectionConfig:
    values: dict[str, Any] = {
        "account_sid": SID,
        "auth_token": TOKEN,
        "phone_number": NUMBER,
        "allowed_senders": ALICE,
        "default_agent": "claude",
        "max_segments_per_reply": 3,
    }
    values.update(overrides)
    return SmsConnectionConfig.model_validate(values)


class Twilio:
    """Twilio's REST API, as far as the adapter calls it."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 200
        self.numbers = [{"sid": "PN1", "phone_number": NUMBER}]
        self.sms_url = ""

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status != 200:
            return httpx.Response(self.status, json={"message": "nope"})
        path = request.url.path
        if path.endswith("/IncomingPhoneNumbers.json"):
            return httpx.Response(200, json={"incoming_phone_numbers": self.numbers})
        if path.endswith("/IncomingPhoneNumbers/PN1.json"):
            if request.method == "POST":
                form = dict(parse_qsl(request.content.decode(), keep_blank_values=True))
                self.sms_url = form["SmsUrl"]
            return httpx.Response(200, json={"sid": "PN1", "sms_url": self.sms_url})
        if path.endswith("/Messages.json"):
            n = sum(1 for r in self.requests if r.url.path.endswith("/Messages.json"))
            return httpx.Response(201, json={"sid": f"SM{n}"})
        return httpx.Response(404, json={"message": "unknown"})

    def sent(self) -> list[dict[str, str]]:
        return [
            dict(parse_qsl(r.content.decode()))
            for r in self.requests
            if r.url.path.endswith("/Messages.json")
        ]


@pytest.fixture
def twilio(monkeypatch: pytest.MonkeyPatch) -> Iterator[Twilio]:
    fake = Twilio()
    monkeypatch.setattr(SmsAdapter, "_transport", httpx.MockTransport(fake.handler))
    yield fake


class Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def message(self, m: InboundMessage) -> None:
        self.messages.append(m)

    async def command(self, c: InboundCommand) -> None:
        self.commands.append(c)


async def _ignore(_: Any) -> None:
    return None


async def _started(twilio: Twilio, **overrides: Any) -> tuple[SmsAdapter, Heard]:
    adapter = SmsAdapter(config=_config(**overrides))
    adapter.set_webhook_url(HOOK)
    heard = Heard()
    await adapter.start(heard.message, heard.command, _ignore, _ignore, _ignore)
    return adapter, heard


def _signed(
    params: dict[str, str], *, token: str = TOKEN, url: str = HOOK
) -> WebhookRequest:
    body = urlencode(params).encode()
    signature = twilio_signature(token, url, params.items())
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: signature},
        query={},
        body=body,
    )


def _sms(
    sid: str = "SM100", sender: str = ALICE, body: str = "hello", **extra: str
) -> dict[str, str]:
    return {
        "MessageSid": sid,
        "AccountSid": SID,
        "From": sender,
        "To": NUMBER,
        "Body": body,
        "NumMedia": "0",
        **extra,
    }


class TestConfig:
    def test_a_valid_config_parses_and_normalises_the_allow_list(self) -> None:
        config = _config(allowed_senders=f" {ALICE},{STRANGER}  ")
        assert config.allowed == {ALICE, STRANGER}
        assert config.allowed_senders == f"{ALICE}, {STRANGER}"

    @pytest.mark.parametrize(
        ("field", "value", "says"),
        [
            ("account_sid", "SK123", "Account SID"),
            ("auth_token", "  ", "Auth Token"),
            ("phone_number", "5005550006", "E.164"),
            ("allowed_senders", "", "at least one"),
            ("allowed_senders", f"{ALICE}, 07700900123", "07700900123"),
            ("max_segments_per_reply", 0, "greater than or equal"),
        ],
    )
    def test_an_unusable_value_is_refused_with_a_clear_message(
        self, field: str, value: Any, says: str
    ) -> None:
        with pytest.raises(ValidationError) as refused:
            _config(**{field: value})
        assert says in str(refused.value)

    def test_the_auth_token_is_masked_on_the_connect_form(self) -> None:
        # Console masks a field whose name contains "token".
        assert "auth_token" in SmsConnectionConfig.model_json_schema()["properties"]


class TestCosts:
    def test_plain_text_is_gsm7_and_emoji_is_ucs2(self) -> None:
        assert segment_count("a" * 160) == 1
        assert segment_count("a" * 161) == 2
        assert segment_count("a" * 306) == 2
        assert segment_count("😀" + "a" * 60) == 1
        assert segment_count("😀" + "a" * 70) == 2

    def test_a_reply_within_the_cap_is_left_alone(self) -> None:
        assert cap_to_segments("short reply", 1) == "short reply"

    def test_a_long_reply_is_cut_at_a_word_and_says_where_the_rest_is(self) -> None:
        text = "word " * 400
        capped = cap_to_segments(text, 2)
        assert capped.endswith(TRUNCATION_NOTE)
        assert segment_count(capped) <= 2
        assert not capped[: -len(TRUNCATION_NOTE)].endswith("wor")

    def test_a_body_over_twilios_limit_is_split_at_boundaries(self) -> None:
        text = ("A sentence that goes on. " * 100).strip()
        pieces = split_body(text)
        assert len(pieces) > 1
        assert all(len(p) <= MAX_BODY for p in pieces)
        assert all(p.endswith(".") for p in pieces[:-1])
        assert " ".join(pieces) == text


class TestTwilioSignature:
    async def test_a_correctly_signed_request_is_accepted(self, twilio: Twilio) -> None:
        adapter, _ = await _started(twilio)
        await adapter.verify_webhook(_signed(_sms()))

    async def test_a_request_signed_with_another_token_is_refused(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(_signed(_sms(), token="someone-elses"))

    async def test_a_request_signed_for_another_address_is_refused(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                _signed(_sms(), url="https://evil.example/messaging/bridges/b-1/events")
            )

    async def test_a_tampered_body_is_refused(self, twilio: Twilio) -> None:
        adapter, _ = await _started(twilio)
        request = _signed(_sms(body="hello"))
        tampered = WebhookRequest(
            method="POST",
            headers=request.headers,
            query={},
            body=request.body.replace(b"hello", b"pay+me"),
        )
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(tampered)

    async def test_an_unsigned_request_is_refused(self, twilio: Twilio) -> None:
        adapter, _ = await _started(twilio)
        request = _signed(_sms())
        unsigned = WebhookRequest(
            method="POST", headers={}, query={}, body=request.body
        )
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(unsigned)

    def test_a_body_without_a_message_sid_is_unreadable(self) -> None:
        adapter = SmsAdapter(config=_config())
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(_signed({"From": ALICE, "Body": "hi"}))

    def test_a_retried_delivery_carries_the_same_event_id(self) -> None:
        adapter = SmsAdapter(config=_config())
        first = adapter.parse_webhook(_signed(_sms(sid="SM7")))
        again = adapter.parse_webhook(_signed(_sms(sid="SM7")))
        assert first.external_event_id == again.external_event_id == "SM7"
        assert first.answers_inline is False


class TestInbound:
    async def test_a_text_from_an_allowed_number_reaches_its_own_direct_room(
        self, twilio: Twilio
    ) -> None:
        adapter, heard = await _started(twilio)
        await adapter.dispatch_event(
            envelope_type="message", payload=_sms(body="hi there")
        )
        [message] = heard.messages
        assert (message.channel_id, message.channel_type) == (ALICE, "direct")
        assert (message.sender_id, message.content, message.message_ref) == (
            ALICE,
            "hi there",
            "SM100",
        )

    async def test_a_text_from_a_stranger_is_dropped_and_not_answered(
        self, twilio: Twilio
    ) -> None:
        adapter, heard = await _started(twilio)
        await adapter.dispatch_event(
            envelope_type="message", payload=_sms(sender=STRANGER)
        )
        assert heard.messages == []
        assert twilio.sent() == []

    async def test_a_text_for_another_twilio_account_is_dropped(
        self, twilio: Twilio
    ) -> None:
        adapter, heard = await _started(twilio)
        await adapter.dispatch_event(
            envelope_type="message", payload=_sms(AccountSid="AC" + "1" * 32)
        )
        assert heard.messages == []

    async def test_a_bang_command_becomes_a_command(self, twilio: Twilio) -> None:
        adapter, heard = await _started(twilio)
        await adapter.dispatch_event(
            envelope_type="message", payload=_sms(body="!invite-agent  reviewer")
        )
        [command] = heard.commands
        assert (command.command, command.args, command.channel_id) == (
            "invite-agent",
            "reviewer",
            ALICE,
        )
        assert heard.messages == []

    async def test_mms_pictures_are_disclosed_as_not_relayed(
        self, twilio: Twilio
    ) -> None:
        adapter, heard = await _started(twilio)
        await adapter.dispatch_event(
            envelope_type="message", payload=_sms(body="look", NumMedia="2")
        )
        [message] = heard.messages
        assert len(message.attachment_failures) == 2
        assert "text only" in message.attachment_failures[0].reason

    async def test_a_new_conversation_starts_with_the_default_agent(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        assert await adapter.get_channel_agent_names(ALICE) == ["claude"]
        bare, _ = await _started(twilio, default_agent="")
        assert await bare.get_channel_agent_names(ALICE) == []


class TestOutbound:
    async def test_a_reply_is_texted_from_the_twilio_number_with_the_agents_name(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        ref = await adapter.send_message(
            ALICE, "claude", adapter.translate_outbound("**Done**: see `app.py`")
        )
        assert ref == "SM1"
        assert twilio.sent() == [
            {"From": NUMBER, "To": ALICE, "Body": "claude: Done: see app.py"}
        ]

    async def test_a_long_reply_is_capped_to_the_segment_limit(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio, max_segments_per_reply=2)
        await adapter.send_message(ALICE, "claude", "word " * 500)
        [sent] = twilio.sent()
        assert sent["Body"].endswith(TRUNCATION_NOTE)
        assert segment_count(sent["Body"]) <= 2

    async def test_a_reply_over_twilios_body_limit_goes_in_several_texts(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio, max_segments_per_reply=30)
        ref = await adapter.send_message(ALICE, "claude", "Line of text. " * 200)
        sent = twilio.sent()
        assert len(sent) == 2
        assert all(len(s["Body"]) <= MAX_BODY for s in sent)
        assert ref == "SM1"

    async def test_switch_never_texts_a_number_off_the_allow_list(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        with pytest.raises(BridgeOperationError):
            await adapter.send_message(STRANGER, "claude", "hi")
        assert twilio.sent() == []

    async def test_edits_deletes_and_typing_send_nothing(self, twilio: Twilio) -> None:
        adapter, _ = await _started(twilio)
        await adapter.update_message(ALICE, "SM1", "changed")
        await adapter.delete_message(ALICE, "SM1")
        await adapter.send_typing(ALICE, "claude", True)
        assert twilio.sent() == []

    async def test_conversations_cannot_be_created_or_joined_from_switch(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("room", "topic")
        left_out = await adapter.add_users_to_channel(ALICE, ["bob"], ["+15550001"])
        assert left_out == ["+15550001"]

    def test_markdown_is_rendered_as_plain_text(self) -> None:
        adapter = SmsAdapter(config=_config())
        rendered = adapter.translate_outbound(
            "# Title\n\nSee [the docs](https://example.com) and *this* ~~not~~.\n```py\nx = 1\n```"
        )
        assert (
            rendered
            == "Title\n\nSee the docs (https://example.com) and this not.\nx = 1"
        )

    def test_the_platform_declares_what_sms_cannot_do(self) -> None:
        assert SmsAdapter.receives_webhooks is True
        assert SmsAdapter.supports_channel_creation is False
        assert SmsAdapter.supports_directory_search is False
        assert SmsAdapter.supports_activity_reactions is False
        assert SmsAdapter.draws_session_activity is False


class TestConnecting:
    async def test_credentials_are_checked_against_the_number(
        self, twilio: Twilio
    ) -> None:
        await SmsAdapter.verify_credentials(_config().model_dump())

    async def test_a_refused_sid_and_token_say_so(self, twilio: Twilio) -> None:
        twilio.status = 401
        with pytest.raises(BridgeCredentialError, match="Account SID and Auth Token"):
            await SmsAdapter.verify_credentials(_config().model_dump())

    async def test_a_number_on_another_account_says_so(self, twilio: Twilio) -> None:
        twilio.numbers = []
        with pytest.raises(BridgeCredentialError, match="not a phone number on this"):
            await SmsAdapter.verify_credentials(_config().model_dump())

    async def test_starting_points_the_numbers_texts_at_this_connection(
        self, twilio: Twilio
    ) -> None:
        await _started(twilio)
        assert twilio.sms_url == HOOK

    async def test_starting_without_a_public_address_is_refused(
        self, twilio: Twilio
    ) -> None:
        adapter = SmsAdapter(config=_config())
        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await adapter.start(_ignore, _ignore, _ignore, _ignore, _ignore)

    async def test_removing_the_connection_stops_the_number_sending_here(
        self, twilio: Twilio
    ) -> None:
        adapter, _ = await _started(twilio)
        await adapter.withdraw()
        assert twilio.sms_url == ""

    def test_transport_failures_are_classified_as_network(self) -> None:
        assert SmsAdapter.classify_failure(httpx.ConnectError("down")) == "network"
        assert SmsAdapter.classify_failure(ValueError("x")) is None
