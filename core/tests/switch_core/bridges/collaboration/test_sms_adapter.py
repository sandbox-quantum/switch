"""The Twilio SMS adapter: webhook authentication, inbound, outbound, credentials."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
from typing import Any
from urllib.parse import parse_qs, urlencode

import httpx
import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundMessage,
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.sms import adapter as sms_adapter
from switch_core.bridges.collaboration.sms.adapter import (
    SmsAdapter,
    SmsConnectionConfig,
)

SID = "AC" + "0" * 32
TOKEN = "test-auth-token"
OURS = "+15550001111"
ALICE = "+15550002222"
STRANGER = "+15559998888"
WEBHOOK = "https://switch.example/messaging/bridges/bridge-1/events"


def twilio_signature(token: str, url: str, params: dict[str, str]) -> str:
    """What Twilio puts in X-Twilio-Signature: base64 HMAC-SHA1 over the URL
    followed by each POST parameter's name and value, sorted by name."""
    data = url + "".join(f"{key}{params[key]}" for key in sorted(params))
    digest = hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def inbound_params(**overrides: str) -> dict[str, str]:
    params = {
        "MessageSid": "SM" + "a" * 32,
        "AccountSid": SID,
        "From": ALICE,
        "To": OURS,
        "Body": "deploy the thing",
        "NumMedia": "0",
    }
    params.update(overrides)
    return params


def signed_request(
    params: dict[str, str],
    *,
    token: str = TOKEN,
    url: str = WEBHOOK,
    signature: str | None = None,
) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={
            "x-twilio-signature": signature
            if signature is not None
            else twilio_signature(token, url, params)
        },
        query={},
        body=urlencode(params).encode(),
    )


def make_config(**overrides: object) -> SmsConnectionConfig:
    values: dict[str, object] = {
        "account_sid": SID,
        "auth_token": TOKEN,
        "phone_number": OURS,
        "allowed_numbers": ALICE,
    }
    values.update(overrides)
    return SmsConnectionConfig.model_validate(values)


def make_adapter(**overrides: object) -> SmsAdapter:
    adapter = SmsAdapter(config=make_config(**overrides))
    adapter.set_webhook_url(WEBHOOK)
    return adapter


class TwilioApi:
    """A fake of Twilio's REST API, served at the HTTP transport."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.sent: list[dict[str, str]] = []
        self.account_status = "active"
        self.owned_numbers = [OURS]
        self.reject_auth = False
        self.send_status = 201
        self.connect_error = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.connect_error:
            raise httpx.ConnectError("unreachable", request=request)
        path = request.url.path
        if self.reject_auth:
            return httpx.Response(
                401, json={"code": 20003, "message": "Authenticate"}, request=request
            )
        if request.method == "GET" and path.endswith(f"/Accounts/{SID}.json"):
            return httpx.Response(
                200, json={"sid": SID, "status": self.account_status}, request=request
            )
        if request.method == "GET" and path.endswith("/IncomingPhoneNumbers.json"):
            wanted = request.url.params.get("PhoneNumber")
            numbers = [
                {"sid": f"PN{index}", "phone_number": number}
                for index, number in enumerate(self.owned_numbers)
                if number == wanted
            ]
            return httpx.Response(
                200, json={"incoming_phone_numbers": numbers}, request=request
            )
        if request.method == "POST" and path.endswith(f"/Accounts/{SID}/Messages.json"):
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if self.send_status != 201:
                return httpx.Response(
                    self.send_status,
                    json={"code": 21211, "message": "Invalid 'To' Phone Number"},
                    request=request,
                )
            self.sent.append(form)
            return httpx.Response(
                201, json={"sid": f"SM{len(self.sent):032d}"}, request=request
            )
        return httpx.Response(404, json={"message": "not found"}, request=request)


@pytest.fixture
def twilio(monkeypatch: pytest.MonkeyPatch) -> TwilioApi:
    api = TwilioApi()
    monkeypatch.setattr(
        sms_adapter,
        "_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(api.handler)),
    )
    return api


class Inbox:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []

    async def on_message(self, message: InboundMessage) -> None:
        self.messages.append(message)


async def started(adapter: SmsAdapter) -> Inbox:
    inbox = Inbox()

    async def ignore(_: Any) -> None:
        return None

    await adapter.start(inbox.on_message, ignore, ignore, ignore, ignore)
    return inbox


class TestWhatThePlatformCannotDo:
    def test_declared_on_the_class(self) -> None:
        assert SmsAdapter.display_name == "SMS"
        assert SmsAdapter.receives_webhooks is True
        assert SmsAdapter.supports_channel_creation is False
        assert SmsAdapter.supports_directory_search is False
        assert SmsAdapter.draws_session_activity is False
        assert SmsAdapter.supports_activity_reactions is False
        assert SmsAdapter.renders_custom_url_schemes is False

    def test_it_is_registered_under_its_key_with_an_icon(self) -> None:
        registration = next(p for p in PLATFORMS if p.key == "sms")
        assert registration.adapter is SmsAdapter
        assert registration.config is SmsConnectionConfig
        platform = SmsAdapter.describe("sms")
        assert platform.display_name == "SMS"
        assert platform.icon_svg is not None and platform.icon_svg.startswith("<svg")

    async def test_a_channel_cannot_be_created(self) -> None:
        with pytest.raises(ChannelCreationUnsupported, match="phone number"):
            await make_adapter().create_channel("room", "topic")

    async def test_every_conversation_is_a_direct_one(self) -> None:
        assert await make_adapter().get_channel_type(ALICE) == "direct"

    async def test_nobody_is_in_a_channel_until_added_in_switch(self) -> None:
        assert await make_adapter().get_channel_agent_names(ALICE) == []


class TestWebhookAuthentication:
    async def test_a_correctly_signed_request_is_accepted(self) -> None:
        await make_adapter().verify_webhook(signed_request(inbound_params()))

    async def test_a_request_signed_with_another_token_is_refused(self) -> None:
        request = signed_request(inbound_params(), token="someone-elses-token")
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(request)

    async def test_a_missing_signature_is_refused(self) -> None:
        request = WebhookRequest(
            method="POST",
            headers={},
            query={},
            body=urlencode(inbound_params()).encode(),
        )
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(request)

    async def test_a_tampered_body_is_refused(self) -> None:
        params = inbound_params()
        genuine = twilio_signature(TOKEN, WEBHOOK, params)
        forged = signed_request({**params, "Body": "wire me money"}, signature=genuine)
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(forged)

    async def test_a_forged_sender_is_refused(self) -> None:
        params = inbound_params()
        genuine = twilio_signature(TOKEN, WEBHOOK, params)
        forged = signed_request({**params, "From": STRANGER}, signature=genuine)
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(forged)

    async def test_a_signature_for_another_url_is_refused(self) -> None:
        request = signed_request(
            inbound_params(), url="https://switch.example/messaging/other/events"
        )
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(request)

    async def test_a_signature_is_not_trusted_from_a_forwarded_host(self) -> None:
        request = signed_request(inbound_params())
        request = WebhookRequest(
            method=request.method,
            headers={**request.headers, "x-forwarded-host": "evil.example"},
            query=request.query,
            body=request.body,
        )
        await make_adapter().verify_webhook(request)

    async def test_a_get_cannot_prove_itself(self) -> None:
        request = WebhookRequest(method="GET", headers={}, query={}, body=b"")
        with pytest.raises(WebhookAuthenticityError):
            await make_adapter().verify_webhook(request)

    async def test_without_an_address_nothing_is_accepted(self) -> None:
        adapter = SmsAdapter(config=make_config())
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(signed_request(inbound_params()))

    async def test_an_oversize_body_is_refused_before_it_is_read(self) -> None:
        request = WebhookRequest(
            method="POST",
            headers={"x-twilio-signature": "x"},
            query={},
            body=b"a=" + b"b" * 70_000,
        )
        with pytest.raises(WebhookAuthenticityError, match="too large"):
            await make_adapter().verify_webhook(request)

    async def test_repeated_parameters_are_signed_in_value_order(self) -> None:
        adapter = make_adapter()
        body = "From=%2B15550002222&MediaUrl0=b&MediaUrl0=a"
        data = WEBHOOK + "From+15550002222" + "MediaUrl0a" + "MediaUrl0b"
        digest = hmac.new(TOKEN.encode(), data.encode(), hashlib.sha1).digest()
        request = WebhookRequest(
            method="POST",
            headers={"x-twilio-signature": base64.b64encode(digest).decode()},
            query={},
            body=body.encode(),
        )
        await adapter.verify_webhook(request)


class TestParseWebhook:
    def test_the_message_sid_identifies_the_delivery(self) -> None:
        params = inbound_params()
        event = make_adapter().parse_webhook(signed_request(params))
        assert event.external_event_id == params["MessageSid"]
        assert event.envelope_type == "sms"
        assert event.handshake is None
        assert event.answers_inline is False
        assert event.payload["From"] == ALICE
        assert event.payload["Body"] == "deploy the thing"

    def test_a_retried_delivery_has_the_same_id(self) -> None:
        adapter = make_adapter()
        first = adapter.parse_webhook(signed_request(inbound_params()))
        again = adapter.parse_webhook(signed_request(inbound_params()))
        assert first.external_event_id == again.external_event_id

    @pytest.mark.parametrize("missing", ["MessageSid", "From"])
    def test_a_body_without_the_essentials_is_unreadable(self, missing: str) -> None:
        params = inbound_params()
        del params[missing]
        with pytest.raises(WebhookPayloadError):
            make_adapter().parse_webhook(signed_request(params))


class TestInbound:
    async def _deliver(self, adapter: SmsAdapter, **overrides: str) -> None:
        event = adapter.parse_webhook(signed_request(inbound_params(**overrides)))
        await adapter.dispatch_event(
            envelope_type=event.envelope_type, payload=event.payload
        )

    async def test_a_text_from_an_allowed_number_reaches_the_room(self) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        await self._deliver(adapter)
        [message] = inbox.messages
        assert message.channel_id == ALICE
        assert message.channel_type == "direct"
        assert message.sender_id == ALICE
        assert message.content == "deploy the thing"
        assert message.message_ref == "SM" + "a" * 32
        assert message.root_id is None

    async def test_a_stranger_is_dropped_and_not_answered(
        self, twilio: TwilioApi, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        with caplog.at_level(logging.WARNING):
            await self._deliver(adapter, **{"From": STRANGER})
        assert inbox.messages == []
        assert twilio.requests == []
        assert STRANGER not in caplog.text
        assert "+15559998888"[-4:] in caplog.text

    async def test_a_text_to_another_number_is_dropped(self) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        await self._deliver(adapter, To="+15557776666")
        assert inbox.messages == []

    async def test_a_text_for_another_account_is_dropped(self) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        await self._deliver(adapter, AccountSid="AC" + "1" * 32)
        assert inbox.messages == []

    async def test_media_is_disclosed_not_dropped(self) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        await self._deliver(adapter, NumMedia="2", Body="look")
        [message] = inbox.messages
        assert message.content == "look"
        assert len(message.attachment_failures) == 2
        assert "not supported" in message.attachment_failures[0].reason

    async def test_an_empty_text_is_not_relayed(self) -> None:
        adapter = make_adapter()
        inbox = await started(adapter)
        await self._deliver(adapter, Body="")
        assert inbox.messages == []

    async def test_a_number_written_differently_still_matches(self) -> None:
        adapter = make_adapter(allowed_numbers="+1 (555) 000-2222")
        inbox = await started(adapter)
        await self._deliver(adapter)
        assert len(inbox.messages) == 1


class TestStart:
    async def test_without_a_public_address_it_refuses_to_start(self) -> None:
        adapter = SmsAdapter(config=make_config())
        adapter.set_webhook_url(None)

        async def ignore(_: Any) -> None:
            return None

        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await adapter.start(ignore, ignore, ignore, ignore, ignore)


class TestOutbound:
    async def test_a_reply_is_sent_through_the_messages_api(
        self, twilio: TwilioApi
    ) -> None:
        adapter = make_adapter()
        ref = await adapter.send_message(ALICE, "builder", "Build passed.")
        assert ref == f"SM{1:032d}"
        [request] = twilio.requests
        assert str(request.url).startswith("https://api.twilio.com/2010-04-01/")
        expected = base64.b64encode(f"{SID}:{TOKEN}".encode()).decode()
        assert request.headers["authorization"] == f"Basic {expected}"
        assert twilio.sent == [
            {"To": ALICE, "From": OURS, "Body": "builder: Build passed."}
        ]

    async def test_markdown_is_sent_as_plain_text(self, twilio: TwilioApi) -> None:
        await make_adapter().send_message(ALICE, "builder", "**Done** in `3s`")
        assert twilio.sent[0]["Body"] == "builder: Done in 3s"

    async def test_a_long_reply_goes_out_in_ordered_numbered_parts(
        self, twilio: TwilioApi
    ) -> None:
        text = " ".join(f"Sentence number {i} is here." for i in range(40))
        ref = await make_adapter(max_segments_per_reply=20).send_message(
            ALICE, "builder", text
        )
        assert len(twilio.sent) > 1
        assert ref == f"SM{1:032d}"
        total = len(twilio.sent)
        for index, form in enumerate(twilio.sent, start=1):
            assert form["Body"].startswith(f"({index}/{total}) ")

    async def test_a_runaway_reply_is_cut_with_a_note(self, twilio: TwilioApi) -> None:
        text = " ".join(f"word{i}" for i in range(5000))
        await make_adapter(max_segments_per_reply=8).send_message(
            ALICE, "builder", text
        )
        assert "Switch Console" in twilio.sent[-1]["Body"]
        cost = sum(sms_adapter.segment_count(form["Body"]) for form in twilio.sent)
        assert cost <= 8

    async def test_a_number_off_the_allow_list_is_never_texted(
        self, twilio: TwilioApi, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.ERROR):
            ref = await make_adapter().send_message(STRANGER, "builder", "hi")
        assert ref is None
        assert twilio.requests == []
        assert "allow-list" in caplog.text

    async def test_the_hourly_cap_stops_a_runaway_sender(
        self, twilio: TwilioApi, caplog: pytest.LogCaptureFixture
    ) -> None:
        adapter = make_adapter(max_segments_per_hour=2)
        assert await adapter.send_message(ALICE, "b", "one") is not None
        assert await adapter.send_message(ALICE, "b", "two") is not None
        with caplog.at_level(logging.WARNING):
            assert await adapter.send_message(ALICE, "b", "three") is None
        assert len(twilio.sent) == 2
        assert "hourly" in caplog.text

    async def test_the_hourly_window_is_per_number(self, twilio: TwilioApi) -> None:
        other = "+15550004444"
        adapter = make_adapter(
            max_segments_per_hour=1, allowed_numbers=f"{ALICE},{other}"
        )
        assert await adapter.send_message(ALICE, "b", "one") is not None
        assert await adapter.send_message(other, "b", "one") is not None

    async def test_the_hourly_window_slides(
        self, twilio: TwilioApi, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        now = [1_000.0]
        monkeypatch.setattr(sms_adapter, "_now", lambda: now[0])
        adapter = make_adapter(max_segments_per_hour=1)
        assert await adapter.send_message(ALICE, "b", "one") is not None
        assert await adapter.send_message(ALICE, "b", "two") is None
        now[0] += 3601
        assert await adapter.send_message(ALICE, "b", "three") is not None

    @pytest.mark.parametrize("status", [400, 401, 429, 500])
    async def test_a_refusal_is_logged_with_twilios_reason_and_returns_none(
        self,
        twilio: TwilioApi,
        caplog: pytest.LogCaptureFixture,
        status: int,
    ) -> None:
        twilio.send_status = status
        with caplog.at_level(logging.ERROR):
            ref = await make_adapter().send_message(ALICE, "builder", "hi")
        assert ref is None
        assert str(status) in caplog.text
        assert "Invalid 'To' Phone Number" in caplog.text
        assert TOKEN not in caplog.text

    async def test_an_unreachable_twilio_is_logged_and_returns_none(
        self, twilio: TwilioApi, caplog: pytest.LogCaptureFixture
    ) -> None:
        twilio.connect_error = True
        with caplog.at_level(logging.ERROR):
            ref = await make_adapter().send_message(ALICE, "builder", "hi")
        assert ref is None
        assert "Twilio" in caplog.text

    async def test_threads_are_ignored(self, twilio: TwilioApi) -> None:
        await make_adapter().send_message(
            ALICE, "builder", "hi", thread_root_id="SMroot"
        )
        assert twilio.sent[0]["Body"] == "builder: hi"

    async def test_edits_and_deletes_are_not_attempted(self, twilio: TwilioApi) -> None:
        adapter = make_adapter()
        await adapter.update_message(ALICE, "SM1", "new text")
        await adapter.delete_message(ALICE, "SM1")
        assert twilio.requests == []

    async def test_an_attachment_is_named_not_relayed(self, twilio: TwilioApi) -> None:
        await make_adapter().send_attachment(
            ALICE, "builder", "report.pdf", "application/pdf", b"%PDF", caption="Here"
        )
        assert "report.pdf" in twilio.sent[0]["Body"]
        assert "MediaUrl" not in twilio.sent[0]


class TestVerifyCredentials:
    def _config(self, **overrides: object) -> dict[str, object]:
        return make_config(**overrides).model_dump()

    async def test_good_credentials_pass(self, twilio: TwilioApi) -> None:
        await SmsAdapter.verify_credentials(self._config())

    async def test_rejected_credentials_are_explained(self, twilio: TwilioApi) -> None:
        twilio.reject_auth = True
        with pytest.raises(BridgeCredentialError, match="Account SID and Auth Token"):
            await SmsAdapter.verify_credentials(self._config())

    async def test_a_number_the_account_does_not_own_is_refused(
        self, twilio: TwilioApi
    ) -> None:
        twilio.owned_numbers = ["+15557770000"]
        with pytest.raises(BridgeCredentialError, match="does not own"):
            await SmsAdapter.verify_credentials(self._config())

    async def test_a_suspended_account_is_refused(self, twilio: TwilioApi) -> None:
        twilio.account_status = "suspended"
        with pytest.raises(BridgeCredentialError, match="suspended"):
            await SmsAdapter.verify_credentials(self._config())

    async def test_an_unreachable_twilio_says_so(self, twilio: TwilioApi) -> None:
        twilio.connect_error = True
        with pytest.raises(BridgeCredentialError, match="Could not reach Twilio"):
            await SmsAdapter.verify_credentials(self._config())

    async def test_the_token_never_appears_in_the_error(
        self, twilio: TwilioApi
    ) -> None:
        twilio.reject_auth = True
        with pytest.raises(BridgeCredentialError) as caught:
            await SmsAdapter.verify_credentials(self._config())
        assert TOKEN not in str(caught.value)


def test_helper_signature_matches_twilios_own_library() -> None:
    """The value twilio.request_validator.RequestValidator computes for this request."""
    url = "https://mycompany.com/myapp.php?foo=1&bar=2"
    params = {
        "CallSid": "CA1234567890ABCDE",
        "Caller": "+12349013030",
        "Digits": "1234",
        "From": "+12349013030",
        "To": "+18005551212",
    }
    assert twilio_signature("12345", url, params) == "0/KCTR6DLpKmkAf8muzZqo1nDgQ="
