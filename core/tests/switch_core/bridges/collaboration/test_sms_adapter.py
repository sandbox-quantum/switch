from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.adapter import (
    ChannelNotBindable,
    RequestCard,
    RichContentFailed,
    TurnActivity,
)
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
    OutboundAttachment,
)
from switch_core.bridges.collaboration.send_ledger import SendLedger, StoredSendLedger
from switch_core.bridges.collaboration.session.renderers import RequestReference
from switch_core.bridges.collaboration.sms.adapter import SmsAdapter
from switch_core.bridges.collaboration.sms.client import TwilioClient, TwilioError
from switch_core.bridges.collaboration.sms.config import SmsConnectionConfig
from switch_core.bridges.collaboration.sms.segments import CUT_NOTICE, count_segments
from switch_core.bridges.collaboration.sms.signature import compute_signature
from switch_core.db.models import TENANT_ZERO_ID
from switch_core.sessions.contract import TurnUpsert

from ...db.stores.test_bridge_send_store import make_bridge
from .session_fixtures import open_request

SID = "AC" + "0" * 32
TOKEN = "test-auth-token"
NUMBER = "+14155550100"
PERSON = "+14155550101"
STRANGER = "+14155550199"
URL = "https://switch.example/messaging/bridges/b1/events"
CONFIG: dict[str, Any] = {
    "account_sid": SID,
    "auth_token": TOKEN,
    "phone_number": NUMBER,
    "allowed_senders": PERSON,
    "default_agent": "helper",
    "max_segments_per_reply": 3,
    "max_segments_per_hour": 6,
}


@dataclass
class FakeTwilio:
    """Twilio's REST API, at the transport."""

    sent: list[dict[str, list[str]]] = field(default_factory=list)
    refusals: list[httpx.Response] = field(default_factory=list)
    account: httpx.Response = field(
        default_factory=lambda: httpx.Response(200, json={"status": "active"})
    )
    numbers: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {"phone_number": NUMBER, "capabilities": {"sms": True}}
        ]
    )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/Messages.json"):
            if self.refusals:
                return self.refusals.pop(0)
            self.sent.append(parse_qs(request.content.decode()))
            return httpx.Response(201, json={"sid": f"SM{len(self.sent)}"})
        if path.endswith("/IncomingPhoneNumbers.json"):
            return httpx.Response(200, json={"incoming_phone_numbers": self.numbers})
        if path.endswith(f"/Accounts/{SID}.json"):
            return self.account
        if "/Media/" in path:
            return httpx.Response(
                200, content=b"image", headers={"content-type": "image/png"}
            )
        raise AssertionError(f"unexpected Twilio call: {path}")


@dataclass
class FakeLedger:
    """One bridge's `bridge_hourly_sends`, within one hour."""

    spends: dict[str, int] = field(default_factory=dict)
    told: set[str] = field(default_factory=set)

    async def spent(self, recipient: str) -> int:
        return self.spends.get(recipient, 0)

    async def spend(self, recipient: str, units: int) -> int:
        self.spends[recipient] = self.spends.get(recipient, 0) + units
        return self.spends[recipient]

    async def refund(self, recipient: str, units: int) -> None:
        self.spends[recipient] = max(self.spends.get(recipient, 0) - units, 0)

    async def claim_limit_notice(self, recipient: str) -> bool:
        if recipient not in self.spends or recipient in self.told:
            return False
        self.told.add(recipient)
        return True

    async def release_limit_notice(self, recipient: str) -> None:
        self.told.discard(recipient)


@dataclass
class Heard:
    messages: list[InboundMessage] = field(default_factory=list)
    commands: list[InboundCommand] = field(default_factory=list)

    async def message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def command(self, command: InboundCommand) -> None:
        self.commands.append(command)


@pytest.fixture
def twilio() -> FakeTwilio:
    return FakeTwilio()


@pytest.fixture
def heard() -> Heard:
    return Heard()


async def started(twilio: FakeTwilio, heard: Heard, ledger: SendLedger) -> SmsAdapter:
    built = SmsAdapter(config=SmsConnectionConfig.model_validate(CONFIG))
    await built._http.aclose()
    built._http = httpx.AsyncClient(transport=httpx.MockTransport(twilio))
    built._client = TwilioClient(http=built._http, account_sid=SID, auth_token=TOKEN)
    built.set_webhook_url(URL)
    built.set_send_ledger(ledger)

    async def ignore(_: Any) -> None:
        return None

    await built.start(heard.message, heard.command, ignore, ignore, ignore)
    return built


@pytest.fixture
async def adapter(twilio: FakeTwilio, heard: Heard) -> AsyncIterator[SmsAdapter]:
    built = await started(twilio, heard, FakeLedger())
    yield built
    await built.stop()


def inbound(**overrides: str) -> dict[str, str]:
    return {
        "MessageSid": "SM100",
        "AccountSid": SID,
        "From": PERSON,
        "To": NUMBER,
        "Body": "hello",
        "NumMedia": "0",
        **overrides,
    }


def signed(
    fields: dict[str, str], url: str = URL, token: str = TOKEN
) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={
            "x-twilio-signature": compute_signature(token, url, list(fields.items()))
        },
        query={},
        body=urlencode(fields).encode(),
    )


async def deliver(adapter: SmsAdapter, fields: dict[str, str]) -> None:
    request = signed(fields)
    await adapter.verify_webhook(request)
    event = adapter.parse_webhook(request)
    await adapter.dispatch_event(
        envelope_type=event.envelope_type, payload=event.payload
    )


def bodies(twilio: FakeTwilio) -> list[str]:
    return [sent["Body"][0] for sent in twilio.sent]


class TestCredentials:
    @staticmethod
    async def _verify(
        twilio: Callable[[httpx.Request], httpx.Response],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        original = httpx.AsyncClient

        def mocked(**kwargs: Any) -> httpx.AsyncClient:
            return original(transport=httpx.MockTransport(twilio), **kwargs)

        monkeypatch.setattr(
            "switch_core.bridges.collaboration.sms.adapter.httpx.AsyncClient", mocked
        )
        await SmsAdapter.verify_credentials(CONFIG)

    async def test_good_credentials_pass(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        await self._verify(twilio, monkeypatch)

    async def test_refused_token_quotes_twilio(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        twilio.account = httpx.Response(
            401, json={"code": 20003, "message": "Authenticate"}
        )
        with pytest.raises(BridgeCredentialError, match="Authenticate"):
            await self._verify(twilio, monkeypatch)

    async def test_unreachable_twilio_is_not_called_bad_credentials(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no")

        with pytest.raises(BridgeOperationError, match="Could not reach Twilio"):
            await self._verify(unreachable, monkeypatch)

    async def test_a_twilio_outage_is_not_called_bad_credentials(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        twilio.account = httpx.Response(503, json={"message": "Service Unavailable"})
        with pytest.raises(BridgeOperationError, match="HTTP 503"):
            await self._verify(twilio, monkeypatch)

    async def test_suspended_account_is_refused(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        twilio.account = httpx.Response(200, json={"status": "suspended"})
        with pytest.raises(BridgeCredentialError, match="suspended"):
            await self._verify(twilio, monkeypatch)

    async def test_number_on_another_account_is_refused(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        twilio.numbers = []
        with pytest.raises(BridgeCredentialError, match="not a phone number on this"):
            await self._verify(twilio, monkeypatch)

    async def test_number_that_cannot_text_is_refused(
        self, twilio: FakeTwilio, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        twilio.numbers = [{"phone_number": NUMBER, "capabilities": {"sms": False}}]
        with pytest.raises(BridgeCredentialError, match="can't send or receive"):
            await self._verify(twilio, monkeypatch)


def test_a_number_is_claimed_however_it_was_typed() -> None:
    assert SmsAdapter.claimed_workspace(
        {**CONFIG, "phone_number": "+1 (415) 555-0100"}
    ) == (f"Twilio number {NUMBER}")


def test_link_code_instructions_say_to_text_the_number() -> None:
    assert SmsAdapter.link_code_instructions("123456", CONFIG) == (
        f"Text `!link-account 123456` from that phone to {NUMBER}."
    )


@pytest.mark.parametrize(
    ("exc", "reason"),
    [
        (TwilioError(status=401, code=20003, message="no"), "auth_failed"),
        (TwilioError(status=400, code=21211, message="no"), "platform_error"),
        (httpx.ConnectError("no"), "network"),
        (ValueError("no"), None),
    ],
)
def test_classify_failure(exc: BaseException, reason: str | None) -> None:
    assert SmsAdapter.classify_failure(exc) == reason


async def test_start_without_a_public_address_is_refused() -> None:
    built = SmsAdapter(config=SmsConnectionConfig.model_validate(CONFIG))

    async def ignore(_: Any) -> None:
        return None

    with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
        await built.start(ignore, ignore, ignore, ignore, ignore)
    assert built._http.is_closed


class TestWebhookProof:
    async def test_signed_request_is_accepted(self, adapter: SmsAdapter) -> None:
        await adapter.verify_webhook(signed(inbound()))

    @pytest.mark.parametrize(
        "request_",
        [
            signed(inbound(), token="another-token"),
            signed(inbound(), url="https://evil.example/events"),
            WebhookRequest("POST", {}, {}, urlencode(inbound()).encode()),
            WebhookRequest("GET", {}, {}, b""),
            signed(inbound(AccountSid="AC" + "1" * 32)),
            signed({k: v for k, v in inbound().items() if k != "AccountSid"}),
        ],
        ids=[
            "other-token",
            "other-url",
            "unsigned",
            "get",
            "other-account",
            "no-account",
        ],
    )
    async def test_unproved_request_is_refused(
        self, adapter: SmsAdapter, request_: WebhookRequest
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(request_)

    async def test_retry_carries_the_same_event_id(self, adapter: SmsAdapter) -> None:
        first = adapter.parse_webhook(signed(inbound()))
        again = adapter.parse_webhook(signed(inbound()))
        assert first.external_event_id == again.external_event_id == "SM100"
        assert first.answers_inline is False

    async def test_each_status_is_its_own_event(self, adapter: SmsAdapter) -> None:
        sent = adapter.parse_webhook(
            signed({"MessageSid": "SM1", "MessageStatus": "sent"})
        )
        delivered = adapter.parse_webhook(
            signed({"MessageSid": "SM1", "MessageStatus": "delivered"})
        )
        assert sent.envelope_type == delivered.envelope_type == "status"
        assert sent.external_event_id != delivered.external_event_id

    async def test_body_without_a_sid_is_refused(self, adapter: SmsAdapter) -> None:
        with pytest.raises(WebhookPayloadError, match="MessageSid"):
            adapter.parse_webhook(signed({"From": PERSON}))


class TestInbound:
    async def test_text_reaches_the_room_side(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound(Body="@helper hi"))
        message = heard.messages[0]
        assert message.channel_id == message.sender_id == PERSON
        assert message.channel_type == "direct"
        assert message.content == "@helper hi"
        assert message.message_ref == "SM100"
        assert message.root_id is None

    async def test_the_full_number_stays_out_of_names(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound())
        message = heard.messages[0]
        assert PERSON not in message.sender_name
        assert PERSON not in str(message.channel_name)

    async def test_stranger_is_ignored_without_a_reply_or_download(
        self,
        adapter: SmsAdapter,
        heard: Heard,
        twilio: FakeTwilio,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.WARNING):
            await deliver(
                adapter,
                inbound(
                    From=STRANGER,
                    NumMedia="1",
                    MediaUrl0="https://api.twilio.com/x/Media/ME1",
                ),
            )
        assert heard.messages == []
        assert twilio.sent == []
        assert STRANGER not in caplog.text

    async def test_message_to_another_number_is_ignored(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound(To="+14155550155"))
        assert heard.messages == []

    @pytest.mark.parametrize(
        "body", ["STOP", " stop ", "Unsubscribe", "START", "unstop", "cancel"]
    )
    async def test_twilio_keywords_do_not_reach_agents(
        self, adapter: SmsAdapter, heard: Heard, body: str
    ) -> None:
        await deliver(adapter, inbound(Body=body))
        assert heard.messages == []

    async def test_opt_out_flag_does_not_reach_agents(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound(Body="please stop", OptOutType="STOP"))
        assert heard.messages == []

    @pytest.mark.parametrize(
        "body", ["yes", "stop the deploy", "A3 yes", "help", "INFO"]
    )
    async def test_ordinary_words_do_reach_agents(
        self, adapter: SmsAdapter, heard: Heard, body: str
    ) -> None:
        await deliver(adapter, inbound(Body=body))
        assert [m.content for m in heard.messages] == [body]

    async def test_command(self, adapter: SmsAdapter, heard: Heard) -> None:
        await deliver(adapter, inbound(Body="!invite helper now"))
        command = heard.commands[0]
        assert (command.command, command.args) == ("invite", "helper now")
        assert command.channel_id == PERSON
        assert heard.messages == []

    async def test_help_flag_still_reaches_agents(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound(Body="help", OptOutType="HELP"))
        assert [m.content for m in heard.messages] == ["help"]

    @pytest.mark.parametrize("body", ["!", "!  ", "wow!"])
    async def test_a_bang_alone_is_just_text(
        self, adapter: SmsAdapter, heard: Heard, body: str
    ) -> None:
        await deliver(adapter, inbound(Body=body))
        assert heard.commands == []
        assert [m.content for m in heard.messages] == [body]

    async def test_mms_is_downloaded(self, adapter: SmsAdapter, heard: Heard) -> None:
        await deliver(
            adapter,
            inbound(
                NumMedia="1",
                MediaUrl0="https://api.twilio.com/x/Media/ME1",
                MediaContentType0="image/png",
            ),
        )
        attachment = heard.messages[0].attachments[0]
        assert attachment.data == b"image"
        assert attachment.mimetype == "image/png"
        assert attachment.filename.endswith(".png")

    async def test_oversized_mms_is_disclosed(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        adapter.set_max_attachment_bytes(2)
        await deliver(
            adapter,
            inbound(NumMedia="1", MediaUrl0="https://api.twilio.com/x/Media/ME1"),
        )
        message = heard.messages[0]
        assert message.attachments == []
        assert "byte limit" in message.attachment_failures[0].reason

    async def test_media_with_no_address_is_disclosed(
        self, adapter: SmsAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, inbound(NumMedia="1"))
        assert heard.messages[0].attachment_failures

    @pytest.mark.parametrize("count", ["", "many", "-1"])
    async def test_unreadable_media_count_is_no_media(
        self, adapter: SmsAdapter, heard: Heard, count: str
    ) -> None:
        await deliver(adapter, inbound(NumMedia=count))
        assert heard.messages[0].attachments == []

    async def test_failed_delivery_status_is_logged_with_its_code(
        self, adapter: SmsAdapter, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level(logging.ERROR):
            await deliver(
                adapter,
                {
                    "MessageSid": "SM1",
                    "AccountSid": SID,
                    "To": PERSON,
                    "MessageStatus": "undelivered",
                    "ErrorCode": "30034",
                },
            )
        assert "isn't registered for A2P 10DLC" in caplog.text
        assert "https://www.twilio.com/docs/api/errors/30034" in caplog.text
        assert PERSON not in caplog.text


class TestOutbound:
    async def test_reply_carries_the_agents_name(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        ref = await adapter.send_message(PERSON, "helper", "all done")
        assert ref == "SM1"
        sent = twilio.sent[0]
        assert sent["From"] == [NUMBER]
        assert sent["To"] == [PERSON]
        assert sent["StatusCallback"] == [URL]
        assert sent["Body"][0].endswith(": all done")
        assert "helper" in sent["Body"][0]

    async def test_a_defused_name_does_not_cost_unicode(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter.send_message(PERSON, "he​lper", "ok")
        assert "​" not in bodies(twilio)[0]

    async def test_markdown_is_rendered_by_translate_outbound(
        self, adapter: SmsAdapter
    ) -> None:
        assert adapter.translate_outbound("**done**") == "done"

    async def test_long_reply_is_cut_to_the_limit_with_a_notice(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter.send_message(PERSON, "helper", "One sentence here. " * 200)
        assert sum(count_segments(b) for b in bodies(twilio)) <= 3
        assert bodies(twilio)[-1].endswith(CUT_NOTICE)

    async def test_number_off_the_allow_list_is_not_texted(
        self,
        adapter: SmsAdapter,
        twilio: FakeTwilio,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.ERROR):
            ref = await adapter.send_message(STRANGER, "helper", "hi")
        assert ref is not None
        assert twilio.sent == []
        assert "not one of this connection's allowed" in caplog.text

    async def test_hourly_limit_stops_a_loop_and_says_so_once(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(20):
            await adapter.send_message(PERSON, "helper", "again")
        texts = bodies(twilio)
        assert len([t for t in texts if t.endswith("again")]) == 6
        assert len([t for t in texts if "paused texts" in t]) == 1
        assert len(texts) == 7

    async def test_reply_is_cut_to_what_is_left_of_the_hour(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(5):
            await adapter.send_message(PERSON, "helper", "again")
        twilio.sent.clear()
        await adapter.send_message(PERSON, "helper", "One sentence here. " * 200)
        assert sum(count_segments(b) for b in bodies(twilio)) == 1

    async def test_opted_out_person_is_not_retried(
        self,
        adapter: SmsAdapter,
        twilio: FakeTwilio,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        for _ in range(2):
            twilio.refusals.append(
                httpx.Response(400, json={"code": 21610, "message": "opted out"})
            )
        with caplog.at_level(logging.WARNING):
            ref = await adapter.send_message(PERSON, "helper", "hi")
            await adapter.send_message(PERSON, "helper", "hi again")
        assert ref is not None
        opted = [r.levelno for r in caplog.records if "opted out" in r.getMessage()]
        assert opted == [logging.ERROR, logging.WARNING]

    async def test_a_refused_send_is_given_back_to_the_hour(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        twilio.refusals.append(httpx.Response(500, json={"message": "boom"}))
        with pytest.raises(TwilioError):
            await adapter.send_message(PERSON, "helper", "hi")
        assert await adapter.send_ledger.spent(PERSON) == 0

    async def test_a_send_to_someone_opted_out_is_given_back_to_the_hour(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        twilio.refusals.append(
            httpx.Response(400, json={"code": 21610, "message": "opted out"})
        )
        await adapter.send_message(PERSON, "helper", "hi")
        assert await adapter.send_ledger.spent(PERSON) == 0

    @pytest.mark.parametrize(
        ("exc", "counted"),
        [
            (httpx.ConnectError("no"), 0),
            (httpx.ConnectTimeout("no"), 0),
            (httpx.ReadTimeout("no"), 1),
        ],
    )
    async def test_only_a_send_that_may_have_gone_out_stays_counted(
        self, adapter: SmsAdapter, exc: httpx.HTTPError, counted: int
    ) -> None:
        def fail(request: httpx.Request) -> httpx.Response:
            raise exc

        adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(fail))
        adapter._client = TwilioClient(
            http=adapter._http, account_sid=SID, auth_token=TOKEN
        )
        with pytest.raises(type(exc)):
            await adapter.send_message(PERSON, "helper", "hi")
        assert await adapter.send_ledger.spent(PERSON) == counted

    async def test_retries_through_an_outage_do_not_spend_the_hour(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(10):
            twilio.refusals.append(httpx.Response(503, json={"message": "down"}))
            with pytest.raises(TwilioError):
                await adapter.send_message(PERSON, "helper", "hi")
        await adapter.send_message(PERSON, "helper", "hi")
        assert bodies(twilio)[-1].endswith("hi")

    async def test_a_reply_stops_where_another_text_spent_the_hour(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter.send_ledger.spend(PERSON, 5)
        ref = await adapter._send_pieces(PERSON, ["one", "two"], capped=True)
        assert ref == "SM1"
        assert bodies(twilio) == ["one"]
        assert await adapter.send_ledger.spent(PERSON) == 6

    async def test_refused_send_raises_so_it_can_be_retried(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        twilio.refusals.append(
            httpx.Response(429, json={"code": 20429, "message": "Too Many"})
        )
        with pytest.raises(TwilioError, match="code 20429"):
            await adapter.send_message(PERSON, "helper", "hi")

    async def test_budget_notice_that_failed_is_sent_next_time(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(6):
            await adapter.send_message(PERSON, "helper", "again")
        twilio.refusals.append(httpx.Response(500, json={"message": "boom"}))
        with pytest.raises(TwilioError):
            await adapter.send_message(PERSON, "helper", "again")
        await adapter.send_message(PERSON, "helper", "again")
        assert "paused texts" in bodies(twilio)[-1]

    async def test_refusal_after_the_first_part_keeps_the_first(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter._send_pieces(PERSON, ["one"], capped=True)
        calls = {"n": 0}
        original = twilio.__call__

        def fail_second(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 2:
                return httpx.Response(500, json={"message": "boom"})
            return original(request)

        adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(fail_second))
        adapter._client = TwilioClient(
            http=adapter._http, account_sid=SID, auth_token=TOKEN
        )
        ref = await adapter._send_pieces(PERSON, ["two", "three"], capped=True)
        assert ref == "SM2"

    async def test_lifecycle_notice_is_not_texted(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        ref = await adapter.admin_message(
            PERSON, "agent restarted", message_type="agent_lifecycle"
        )
        assert ref is not None
        assert twilio.sent == []

    async def test_command_result_is_texted_without_its_emoji(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter.admin_message(
            PERSON, "⚠️ **No** such command", message_type="command_result"
        )
        assert bodies(twilio)[0].endswith("No such command")

    async def test_attachments_are_named_in_one_text(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        files = [
            OutboundAttachment(filename=n, mimetype="text/plain", data=b"x")
            for n in ("a.txt", "b.txt")
        ]
        await adapter.send_attachments(PERSON, "helper", files, caption="see")
        assert len(twilio.sent) == 1
        assert "a.txt, b.txt" in bodies(twilio)[0]
        assert "see" in bodies(twilio)[0]

    async def test_edit_and_delete_send_nothing(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        await adapter.update_message(PERSON, "SM1", "new")
        await adapter.delete_message(PERSON, "SM1")
        await adapter.send_typing(PERSON, "helper", True)
        assert twilio.sent == []


class TestChannels:
    async def test_declared_abilities(self) -> None:
        assert SmsAdapter.receives_webhooks
        assert not SmsAdapter.supports_channel_creation
        assert not SmsAdapter.supports_directory_search
        assert not SmsAdapter.supports_activity_reactions
        assert SmsAdapter.draws_session_activity

    async def test_creating_a_channel_is_refused(self, adapter: SmsAdapter) -> None:
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("name", "topic")

    async def test_nobody_can_be_added(self, adapter: SmsAdapter) -> None:
        assert await adapter.add_users_to_channel(PERSON, ["a"], ["1"]) == ["1"]

    async def test_a_first_text_gets_the_configured_agent(
        self, adapter: SmsAdapter
    ) -> None:
        assert await adapter.get_channel_agent_names(PERSON) == ["helper"]

    async def test_room_binds_only_to_an_allowed_number(
        self, adapter: SmsAdapter
    ) -> None:
        await adapter.require_bindable_channel(PERSON)
        with pytest.raises(ChannelNotBindable):
            await adapter.require_bindable_channel(STRANGER)


class TestSessionActivity:
    async def test_a_turn_costs_no_text(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-1", status="running", command_id=None
        )
        ref = await adapter.post_rich(PERSON, "helper", TurnActivity([], turn))
        await adapter.update_rich(PERSON, "helper", ref, TurnActivity([], turn), None)
        assert ref == "turn:t-1"
        assert twilio.sent == []

    async def test_a_problem_somebody_has_to_act_on_is_texted(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-2", status="error", command_id=None
        )
        ref = await adapter.post_rich(
            PERSON,
            "helper",
            TurnActivity(
                [], turn, status_only=True, error_summary="Agent went offline"
            ),
        )
        assert ref == "SM1"
        assert "Agent went offline" in bodies(twilio)[0]
        assert "Working" not in bodies(twilio)[0]

    async def test_a_card_stops_at_the_hourly_limit(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(7):
            await adapter.send_message(PERSON, "helper", "again")
        twilio.sent.clear()
        ref = await adapter.post_rich(
            PERSON,
            "helper",
            RequestCard(open_request(), RequestReference("token", "R42")),
        )
        assert ref is not None
        assert twilio.sent == []

    async def test_a_problem_stops_at_the_hourly_limit(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        for _ in range(7):
            await adapter.send_message(PERSON, "helper", "again")
        twilio.sent.clear()
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-3", status="error", command_id=None
        )
        ref = await adapter.post_rich(
            PERSON,
            "helper",
            TurnActivity([], turn, status_only=True, error_summary="Needs you"),
        )
        assert ref is not None
        assert twilio.sent == []

    async def test_a_refused_card_reports_the_failure(
        self, adapter: SmsAdapter, twilio: FakeTwilio
    ) -> None:
        twilio.refusals.append(httpx.Response(500, json={"message": "boom"}))
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-4", status="error", command_id=None
        )
        with pytest.raises(RichContentFailed, match="HTTP 500"):
            await adapter.post_rich(
                PERSON,
                "helper",
                TurnActivity([], turn, status_only=True, error_summary="x"),
            )


class TestSeveralProcesses:
    """Two copies of the bridge, as two switch-core processes run it, sharing
    the hour's count in the database."""

    async def test_the_hourly_limit_and_its_notice_hold_across_processes(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        twilio: FakeTwilio,
        heard: Heard,
    ) -> None:
        bridge_id = await make_bridge(session_factory)
        copies = [
            await started(
                twilio,
                heard,
                StoredSendLedger(
                    session_factory=session_factory,
                    tenant_id=TENANT_ZERO_ID,
                    bridge_id=bridge_id,
                ),
            )
            for _ in range(2)
        ]
        try:
            for _ in range(10):
                for copy in copies:
                    await copy.send_message(PERSON, "helper", "again")
        finally:
            for copy in copies:
                await copy.stop()
        texts = bodies(twilio)
        assert len([t for t in texts if t.endswith("again")]) == 6
        assert len([t for t in texts if "paused texts" in t]) == 1
