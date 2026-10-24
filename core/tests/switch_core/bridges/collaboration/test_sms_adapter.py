"""Tests for the Twilio SMS collaboration bridge adapter."""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any
from unittest.mock import AsyncMock
from urllib.parse import urlencode

import httpx
import pytest
from pydantic import ValidationError as PydanticValidationError

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeCredentialError,
    BridgeOperationError,
    InboundCommand,
    InboundMessage,
)
from switch_core.bridges.collaboration.sms.adapter import (
    SmsAdapter,
    SmsConnectionConfig,
)
from switch_core.bridges.collaboration.sms.chunking import (
    calculate_segments,
    gsm7_encoded_length,
    is_gsm7,
    render_bounded_sms,
    strip_markdown,
    ucs2_encoded_length,
)

VALID_ACCOUNT_SID = "AC" + "1" * 32
VALID_AUTH_TOKEN = "test_auth_token_secret_12345"
VALID_PHONE = "+15551234567"
ALLOWED_USER = "+15559876543"


def _make_config(**kwargs: Any) -> SmsConnectionConfig:
    defaults: dict[str, Any] = {
        "account_sid": VALID_ACCOUNT_SID,
        "auth_token": VALID_AUTH_TOKEN,
        "phone_number": VALID_PHONE,
        "allowed_numbers": ALLOWED_USER,
        "max_segments": 3,
    }
    defaults.update(kwargs)
    return SmsConnectionConfig.model_validate(defaults)


def _sign(auth_token: str, url: str, params: dict[str, str]) -> str:
    items = sorted(params.items())
    data = url + "".join(f"{k}{v}" for k, v in items)
    return base64.b64encode(
        hmac.new(
            auth_token.encode("utf-8"), data.encode("utf-8"), hashlib.sha1
        ).digest()
    ).decode("utf-8")


# ==============================================================================
# 1. Config Validation
# ==============================================================================


class TestSmsConnectionConfig:
    def test_valid_config(self) -> None:
        cfg = _make_config(allowed_numbers="+15551112222, +15553334444")
        assert cfg.account_sid == VALID_ACCOUNT_SID
        assert cfg.phone_number == "+15551234567"
        assert cfg.allowed_numbers_set == {"+15551112222", "+15553334444"}
        assert cfg.max_segments == 3

    def test_account_sid_validation(self) -> None:
        with pytest.raises(PydanticValidationError, match="Account SID"):
            _make_config(account_sid="INVALID_SID")

        with pytest.raises(PydanticValidationError, match="Account SID"):
            _make_config(account_sid="AC123")  # Too short

    def test_phone_number_validation(self) -> None:
        with pytest.raises(PydanticValidationError, match="E.164"):
            _make_config(phone_number="not-a-number")

        # Normalization of formatted number
        cfg = _make_config(phone_number="+1 (555) 123-4567")
        assert cfg.phone_number == "+15551234567"

    def test_allowed_numbers_mandatory(self) -> None:
        with pytest.raises(PydanticValidationError, match="allowed phone number"):
            _make_config(allowed_numbers="")

        with pytest.raises(PydanticValidationError, match="allowed phone number"):
            _make_config(allowed_numbers="   ")

        with pytest.raises(PydanticValidationError, match="E.164"):
            _make_config(allowed_numbers="bad_number")


# ==============================================================================
# 2. Chunking and Segment Estimation
# ==============================================================================


class TestSmsChunking:
    def test_gsm7_detection(self) -> None:
        assert is_gsm7("Hello world! 1234567890")
        assert is_gsm7("Line 1\nLine 2 @ £ $")
        assert is_gsm7("Bracket [test] and {brace} | €")  # Extended GSM-7
        assert not is_gsm7("Emoji 🚀 triggers UCS-2")
        assert not is_gsm7("Smart quotes ‘test’ triggers UCS-2")

    def test_gsm7_extended_length(self) -> None:
        # Regular GSM-7 chars count 1, extended chars count 2
        text = "Hello [world]"  # [ and ] cost 2 each: 11 basic + 2*2 = 15
        assert gsm7_encoded_length(text) == 15

    def test_calculate_segments(self) -> None:
        # GSM-7 single segment up to 160
        gsm_short = "A" * 160
        segs, enc = calculate_segments(gsm_short)
        assert segs == 1
        assert enc == "gsm7"

        # GSM-7 concatenated: 161 chars needs 2 segments (153 + 8)
        gsm_multi = "A" * 161
        segs, enc = calculate_segments(gsm_multi)
        assert segs == 2
        assert enc == "gsm7"

        # UCS-2 single segment up to 70
        ucs_short = "🚀" + "A" * 68
        segs, enc = calculate_segments(ucs_short)
        assert segs == 1
        assert enc == "ucs2"

        # UCS-2 concatenated: 71 chars needs 2 segments (67 + 4)
        ucs_multi = "🚀" + "A" * 70
        segs, enc = calculate_segments(ucs_multi)
        assert segs == 2
        assert enc == "ucs2"

    def test_strip_markdown(self) -> None:
        md = "# Header\nThis is **bold** and *italic* and `code`.\nCheck [Docs](https://example.com)!"
        clean = strip_markdown(md)
        assert (
            clean
            == "Header\nThis is bold and italic and code.\nCheck Docs (https://example.com)!"
        )

    def test_render_bounded_sms_fits_in_budget(self) -> None:
        rendered = render_bounded_sms("Bot", "Short reply", max_segments=3)
        assert rendered == "[Bot] Short reply"

    def test_render_bounded_sms_truncates_when_exceeding(self) -> None:
        long_content = "This is a very long agent response. " * 30
        rendered = render_bounded_sms("TestAgent", long_content, max_segments=1)
        assert rendered.startswith("[TestAgent] ")
        assert "[...truncated to 1 segments]" in rendered
        # Ensure total rendered fits strictly in 1 GSM-7 segment (<= 160 chars)
        assert gsm7_encoded_length(rendered) <= 160


# ==============================================================================
# 3. Credential Verification and Failure Classification
# ==============================================================================


class TestSmsCredentials:
    async def test_verify_credentials_success(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            url_str = str(request.url)
            if f"/Accounts/{VALID_ACCOUNT_SID}.json" in url_str:
                return httpx.Response(
                    200, json={"sid": VALID_ACCOUNT_SID, "status": "active"}
                )
            if "/IncomingPhoneNumbers.json" in url_str:
                return httpx.Response(
                    200,
                    json={
                        "incoming_phone_numbers": [
                            {
                                "phone_number": VALID_PHONE,
                                "capabilities": {"sms": True, "mms": True},
                            }
                        ]
                    },
                )
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        with httpx.Client(transport=transport):
            # Patch AsyncClient to use mock transport
            orig_async_init = httpx.AsyncClient.__init__

            def mock_init(self: Any, *args: Any, **kw: Any) -> None:
                kw["transport"] = transport
                orig_async_init(self, *args, **kw)

            httpx.AsyncClient.__init__ = mock_init  # type: ignore[method-assign]
            try:
                await SmsAdapter.verify_credentials(
                    {
                        "account_sid": VALID_ACCOUNT_SID,
                        "auth_token": VALID_AUTH_TOKEN,
                        "phone_number": VALID_PHONE,
                    }
                )
            finally:
                httpx.AsyncClient.__init__ = orig_async_init  # type: ignore[method-assign]

    async def test_verify_credentials_auth_failed(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"message": "Authenticate"})

        transport = httpx.MockTransport(handler)
        orig_async_init = httpx.AsyncClient.__init__

        def mock_init(self: Any, *args: Any, **kw: Any) -> None:
            kw["transport"] = transport
            orig_async_init(self, *args, **kw)

        httpx.AsyncClient.__init__ = mock_init  # type: ignore[method-assign]
        try:
            with pytest.raises(
                BridgeCredentialError, match="Twilio credentials rejected"
            ):
                await SmsAdapter.verify_credentials(
                    {
                        "account_sid": VALID_ACCOUNT_SID,
                        "auth_token": "wrong_token",
                        "phone_number": VALID_PHONE,
                    }
                )
        finally:
            httpx.AsyncClient.__init__ = orig_async_init  # type: ignore[method-assign]

    async def test_verify_credentials_phone_not_found(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            url_str = str(request.url)
            if f"/Accounts/{VALID_ACCOUNT_SID}.json" in url_str:
                return httpx.Response(200, json={"sid": VALID_ACCOUNT_SID})
            if "/IncomingPhoneNumbers.json" in url_str:
                return httpx.Response(200, json={"incoming_phone_numbers": []})
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        orig_async_init = httpx.AsyncClient.__init__

        def mock_init(self: Any, *args: Any, **kw: Any) -> None:
            kw["transport"] = transport
            orig_async_init(self, *args, **kw)

        httpx.AsyncClient.__init__ = mock_init  # type: ignore[method-assign]
        try:
            with pytest.raises(
                BridgeCredentialError, match="not found in Twilio account"
            ):
                await SmsAdapter.verify_credentials(
                    {
                        "account_sid": VALID_ACCOUNT_SID,
                        "auth_token": VALID_AUTH_TOKEN,
                        "phone_number": VALID_PHONE,
                    }
                )
        finally:
            httpx.AsyncClient.__init__ = orig_async_init  # type: ignore[method-assign]

    def test_classify_failure(self) -> None:
        assert (
            SmsAdapter.classify_failure(BridgeCredentialError("bad")) == "auth_failed"
        )
        assert (
            SmsAdapter.classify_failure(BridgeOperationError("fail"))
            == "platform_error"
        )

        resp_401 = httpx.Response(401)
        exc_401 = httpx.HTTPStatusError(
            "unauthorized", request=httpx.Request("GET", "http://x"), response=resp_401
        )
        assert SmsAdapter.classify_failure(exc_401) == "auth_failed"

        resp_429 = httpx.Response(429)
        exc_429 = httpx.HTTPStatusError(
            "rate limited", request=httpx.Request("GET", "http://x"), response=resp_429
        )
        assert SmsAdapter.classify_failure(exc_429) == "network"

        resp_400 = httpx.Response(400)
        exc_400 = httpx.HTTPStatusError(
            "bad req", request=httpx.Request("GET", "http://x"), response=resp_400
        )
        assert SmsAdapter.classify_failure(exc_400) == "config_invalid"

        resp_500 = httpx.Response(500)
        exc_500 = httpx.HTTPStatusError(
            "err", request=httpx.Request("GET", "http://x"), response=resp_500
        )
        assert SmsAdapter.classify_failure(exc_500) == "platform_error"

        timeout_exc = httpx.ConnectTimeout("timed out")
        assert SmsAdapter.classify_failure(timeout_exc) == "network"


# ==============================================================================
# 4. Webhook Security and Parsing
# ==============================================================================


class TestSmsWebhookSecurity:
    async def test_valid_signature_accepted(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        url = "https://example.com/messaging/bridges/bridge-1/events"
        adapter.set_webhook_url(url)

        body_params = {
            "AccountSid": VALID_ACCOUNT_SID,
            "From": ALLOWED_USER,
            "To": VALID_PHONE,
            "Body": "Hello agent",
            "MessageSid": "SM1234567890abcdef1234567890abcdef",
        }
        sig = _sign(VALID_AUTH_TOKEN, url, body_params)
        body_bytes = urlencode(body_params).encode("utf-8")

        req = WebhookRequest(
            method="POST",
            headers={"x-twilio-signature": sig},
            query={},
            body=body_bytes,
        )

        await adapter.verify_webhook(req)
        inbound = adapter.parse_webhook(req)
        assert inbound.external_event_id == "SM1234567890abcdef1234567890abcdef"
        assert inbound.payload["Body"] == "Hello agent"

    async def test_forged_signature_rejected(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        url = "https://example.com/messaging/bridges/bridge-1/events"
        adapter.set_webhook_url(url)

        req = WebhookRequest(
            method="POST",
            headers={"x-twilio-signature": "forged_signature_xyz"},
            query={},
            body=b"From=%2B15559876543&Body=test&MessageSid=SM123",
        )

        with pytest.raises(WebhookAuthenticityError, match="validation failed"):
            await adapter.verify_webhook(req)

    async def test_missing_signature_rejected(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        adapter.set_webhook_url("https://example.com")
        req = WebhookRequest(method="POST", headers={}, query={}, body=b"test")
        with pytest.raises(
            WebhookAuthenticityError, match="Missing X-Twilio-Signature"
        ):
            await adapter.verify_webhook(req)

    def test_missing_message_sid_rejected(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        req = WebhookRequest(
            method="POST", headers={}, query={}, body=b"From=%2B12345&Body=hi"
        )
        with pytest.raises(WebhookPayloadError, match="missing MessageSid"):
            adapter.parse_webhook(req)


# ==============================================================================
# 5. Inbound Dispatching and Allow-List Protection
# ==============================================================================


class TestSmsDispatch:
    async def test_allowlisted_message_dispatches(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        on_message = AsyncMock()
        on_command = AsyncMock()
        await adapter.start(
            on_message=on_message,
            on_command=on_command,
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        payload = {
            "AccountSid": VALID_ACCOUNT_SID,
            "From": ALLOWED_USER,
            "To": VALID_PHONE,
            "Body": "Hello Switch",
            "MessageSid": "SM999",
        }

        await adapter.dispatch_event(envelope_type="sms_message", payload=payload)

        on_message.assert_awaited_once()
        assert on_message.call_args is not None
        msg: InboundMessage = on_message.call_args[0][0]
        assert msg.channel_id == ALLOWED_USER
        assert msg.channel_type == "direct"
        assert msg.content == "Hello Switch"
        assert msg.message_ref == "SM999"

    async def test_non_allowlisted_sender_dropped_silently(self) -> None:
        adapter = SmsAdapter(config=_make_config(allowed_numbers=ALLOWED_USER))
        on_message = AsyncMock()
        await adapter.start(
            on_message=on_message,
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        unauthorized_sender = "+19998887777"
        payload = {
            "AccountSid": VALID_ACCOUNT_SID,
            "From": unauthorized_sender,
            "To": VALID_PHONE,
            "Body": "Unapproved message",
            "MessageSid": "SM000",
        }

        await adapter.dispatch_event(envelope_type="sms_message", payload=payload)
        on_message.assert_not_awaited()

    async def test_command_dispatched(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        on_command = AsyncMock()
        await adapter.start(
            on_message=AsyncMock(),
            on_command=on_command,
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        payload = {
            "AccountSid": VALID_ACCOUNT_SID,
            "From": ALLOWED_USER,
            "To": VALID_PHONE,
            "Body": "!status --all",
            "MessageSid": "SMcmd",
        }

        await adapter.dispatch_event(envelope_type="sms_message", payload=payload)

        on_command.assert_awaited_once()
        assert on_command.call_args is not None
        cmd: InboundCommand = on_command.call_args[0][0]
        assert cmd.channel_id == ALLOWED_USER
        assert cmd.channel_type == "direct"
        assert cmd.command == "status"
        assert cmd.args == "--all"


# ==============================================================================
# 6. Outbound Sending & Lifecycle
# ==============================================================================


class TestSmsOutbound:
    async def test_send_message_calls_twilio_api(self) -> None:
        adapter = SmsAdapter(config=_make_config(max_segments=2))
        sent_payloads: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if "Messages.json" in str(request.url):
                # parse urlencoded data
                data = dict(httpx.QueryParams(request.content.decode("utf-8")))
                sent_payloads.append(data)
                return httpx.Response(201, json={"sid": "SMout123"})
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        adapter._client = httpx.AsyncClient(
            transport=transport, base_url="https://api.twilio.com/2010-04-01"
        )

        sid = await adapter.send_message(
            channel_id=ALLOWED_USER,
            sender_name="DemoAgent",
            content="Hello from agent",
        )

        assert sid == "SMout123"
        assert len(sent_payloads) == 1
        assert sent_payloads[0]["From"] == VALID_PHONE
        assert sent_payloads[0]["To"] == ALLOWED_USER
        assert sent_payloads[0]["Body"] == "[DemoAgent] Hello from agent"

    async def test_unsupported_operations_behave_correctly(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        assert await adapter.update_message("c", "m", "content") is None
        assert await adapter.delete_message("c", "m") is None
        assert await adapter.send_typing("c") is None
        assert await adapter.get_channel_type("c") == "direct"
        with pytest.raises(NotImplementedError):
            await adapter.create_channel("name")

    async def test_send_attachment_with_media_url_calls_twilio(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        sent_payloads: list[dict[str, Any]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if "Messages.json" in str(request.url):
                data = dict(httpx.QueryParams(request.content.decode("utf-8")))
                sent_payloads.append(data)
                return httpx.Response(201, json={"sid": "SMmms123"})
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)
        adapter._client = httpx.AsyncClient(
            transport=transport, base_url="https://api.twilio.com/2010-04-01"
        )

        sid = await adapter.send_attachment(
            channel_id=ALLOWED_USER,
            sender_name="MmsAgent",
            filename="photo.jpg",
            mimetype="image/jpeg",
            data=b"fakebytes",
            caption="Here is the chart: https://example.com/chart.jpg",
        )

        assert sid == "SMmms123"
        assert len(sent_payloads) == 1
        assert sent_payloads[0]["MediaUrl"] == "https://example.com/chart.jpg"


# ==============================================================================
# 7. Advanced Edge Cases & Encoding Parity
# ==============================================================================


class TestSmsAdvancedCases:
    def test_ucs2_surrogate_pairs_counted_as_two_code_units(self) -> None:
        # Standard Python len() says 1 for emoji 🚀 (U+1F680), but UCS-2 wire encoding is 2 code units
        emoji = "🚀"
        assert len(emoji) == 1
        assert ucs2_encoded_length(emoji) == 2

        # 35 emojis = 70 UCS-2 code units -> exactly 1 segment
        single_seg_emojis = emoji * 35
        segs, enc = calculate_segments(single_seg_emojis)
        assert segs == 1
        assert enc == "ucs2"

        # 36 emojis = 72 UCS-2 code units -> 2 segments (concatenation boundary at 67)
        two_seg_emojis = emoji * 36
        segs, enc = calculate_segments(two_seg_emojis)
        assert segs == 2
        assert enc == "ucs2"

    async def test_signature_with_repeated_form_parameters(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        url = "https://example.com/messaging/bridges/b1/events"
        adapter.set_webhook_url(url)

        # Repeated parameters (e.g. MediaUrl0, or multiple values for same key)
        params_list = [("MediaUrl", "https://ex.com/1"), ("MediaUrl", "https://ex.com/2"), ("From", ALLOWED_USER)]
        items = sorted(params_list)
        data = url + "".join(f"{k}{v}" for k, v in items)
        sig = base64.b64encode(
            hmac.new(VALID_AUTH_TOKEN.encode("utf-8"), data.encode("utf-8"), hashlib.sha1).digest()
        ).decode("utf-8")

        body_bytes = b"MediaUrl=https%3A%2F%2Fex.com%2F1&MediaUrl=https%3A%2F%2Fex.com%2F2&From=%2B15559876543"
        req = WebhookRequest(
            method="POST",
            headers={"x-twilio-signature": sig},
            query={},
            body=body_bytes,
        )

        await adapter.verify_webhook(req)

    async def test_unaddressed_message_reaches_room(self) -> None:
        adapter = SmsAdapter(config=_make_config())
        on_message = AsyncMock()
        await adapter.start(
            on_message=on_message,
            on_command=AsyncMock(),
            on_agent_joined=AsyncMock(),
            on_user_joined=AsyncMock(),
            on_app_joined=AsyncMock(),
        )

        # Unaddressed message (no @agent tag)
        payload = {
            "AccountSid": VALID_ACCOUNT_SID,
            "From": ALLOWED_USER,
            "To": VALID_PHONE,
            "Body": "System report request",
            "MessageSid": "SMunaddressed1",
        }

        await adapter.dispatch_event(envelope_type="sms_message", payload=payload)

        on_message.assert_awaited_once()
        assert on_message.call_args is not None
        msg: InboundMessage = on_message.call_args[0][0]
        assert msg.content == "System report request"
        assert msg.channel_id == ALLOWED_USER

