"""The WhatsApp adapter against a Graph API mocked at the HTTP transport.

Payloads are shaped as the Cloud API sends them; nothing of the adapter itself
is replaced, so what is asserted is what would reach Meta.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import (
    ActivityMarkRefused,
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
)
from switch_core.bridges.collaboration.platforms import PLATFORMS
from switch_core.bridges.collaboration.whatsapp.adapter import (
    MAX_VIDEO_BYTES,
    SIGNATURE_HEADER,
    WINDOW_CLOSED,
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
    sign,
)
from switch_core.bridges.collaboration.whatsapp.client import (
    GRAPH_API_VERSION,
    WhatsAppGraphError,
    graph_error,
)
from switch_core.sessions.contract import TurnUpsert

APP_ID = "1234567890123456"
PHONE_NUMBER_ID = "106540352242922"
BUSINESS_NUMBER = "15550783881"
PERSON = "16505551234"
CONFIG = {
    "access_token": "EAAtest-token",
    "app_id": APP_ID,
    "phone_number_id": PHONE_NUMBER_ID,
    "app_secret": "app-secret-value",
    "verify_token": "chosen-verify-token",
}
PROOF = hmac.new(
    CONFIG["app_secret"].encode(), CONFIG["access_token"].encode(), hashlib.sha256
).hexdigest()
API = f"/{GRAPH_API_VERSION}"

Handler = Callable[[httpx.Request], httpx.Response]


def graph_refusal(status: int, code: int, message: str) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "error": {
                "message": message,
                "type": "OAuthException",
                "code": code,
                "error_data": {"messaging_product": "whatsapp", "details": message},
                "fbtrace_id": "trace",
            }
        },
    )


class FakeGraph:
    """Records every request to Graph and answers it from a route table.

    A message send is answered with a fresh `wamid` unless a route says
    otherwise, which is what the Cloud API does with an accepted message.
    """

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.routes: dict[tuple[str, str], Handler] = {}
        self._sent = 0

    def on(self, method: str, path: str, handler: Handler) -> None:
        self.routes[(method, path)] = handler

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        route = self.routes.get((request.method, request.url.path))
        if route is not None:
            return route(request)
        if request.method == "POST" and request.url.path.endswith("/messages"):
            if json.loads(request.content).get("status") == "read":
                return httpx.Response(200, json={"success": True})
            self._sent += 1
            return httpx.Response(
                200,
                json={
                    "messaging_product": "whatsapp",
                    "contacts": [{"input": PERSON, "wa_id": PERSON}],
                    "messages": [{"id": f"wamid.out{self._sent}"}],
                },
            )
        return httpx.Response(404, json={"error": {"message": "no route"}})

    def sends(self) -> list[dict[str, Any]]:
        """The bodies of every message send, read receipts left out."""
        bodies = [
            json.loads(r.content)
            for r in self.requests
            if r.method == "POST" and r.url.path.endswith("/messages")
        ]
        return [b for b in bodies if b.get("status") != "read"]

    def receipts(self) -> list[dict[str, Any]]:
        return [
            body
            for r in self.requests
            if r.method == "POST" and r.url.path.endswith("/messages")
            for body in [json.loads(r.content)]
            if body.get("status") == "read"
        ]


@pytest.fixture
def graph(monkeypatch: pytest.MonkeyPatch) -> FakeGraph:
    fake = FakeGraph()
    real_client = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs.setdefault("transport", httpx.MockTransport(fake.handle))
        return real_client(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return fake


@pytest.fixture
async def adapter(graph: FakeGraph) -> Any:
    adapter = WhatsAppAdapter(config=WhatsAppConnectionConfig.model_validate(CONFIG))
    adapter.set_webhook_url("https://switch.example/messaging/bridges/b-1/events")
    yield adapter
    await adapter.stop()


class Heard:
    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []

    async def message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def command(self, command: InboundCommand) -> None:
        self.commands.append(command)


@pytest.fixture
async def heard(adapter: WhatsAppAdapter) -> Heard:
    heard = Heard()

    async def ignore(_: Any) -> None:
        return None

    await adapter.start(heard.message, heard.command, ignore, ignore, ignore)
    return heard


def envelope(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "102290129340398",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": BUSINESS_NUMBER,
                                "phone_number_id": PHONE_NUMBER_ID,
                            },
                            **value,
                        },
                    }
                ],
            }
        ],
    }


def inbound(
    message: dict[str, Any], *, sender: str = PERSON, name: str = "Ada Lovelace"
) -> dict[str, Any]:
    return envelope(
        {
            "contacts": [{"profile": {"name": name}, "wa_id": sender}],
            "messages": [
                {"from": sender, "timestamp": "1761700000", **message},
            ],
        }
    )


def text(
    wamid: str, body: str, *, sender: str = PERSON, **extra: Any
) -> dict[str, Any]:
    return inbound(
        {"id": wamid, "type": "text", "text": {"body": body}, **extra}, sender=sender
    )


def post(payload: dict[str, Any], secret: str = CONFIG["app_secret"]) -> WebhookRequest:
    body = json.dumps(payload).encode()
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: sign(secret, body)},
        query={},
        body=body,
    )


async def deliver(adapter: WhatsAppAdapter, payload: dict[str, Any]) -> None:
    request = post(payload)
    await adapter.verify_webhook(request)
    event = adapter.parse_webhook(request)
    await adapter.dispatch_event(
        envelope_type=event.envelope_type, payload=event.payload
    )


# ── Registration and declarations ─────────────────────────────────────────────


class TestTheAdapterDeclaresItself:
    def test_it_is_registered_under_its_key(self) -> None:
        keys = {p.key: p for p in PLATFORMS}
        assert keys["whatsapp"].adapter is WhatsAppAdapter
        assert keys["whatsapp"].config is WhatsAppConnectionConfig

    def test_it_ships_its_name_and_logo(self) -> None:
        described = WhatsAppAdapter.describe("whatsapp")
        assert described.display_name == "WhatsApp"
        assert described.icon_svg is not None and "<svg" in described.icon_svg
        assert described.docs_slug is None

    def test_what_whatsapp_cannot_do_is_declared(self) -> None:
        assert WhatsAppAdapter.receives_webhooks is True
        assert WhatsAppAdapter.supports_channel_creation is False
        assert WhatsAppAdapter.supports_directory_search is False
        assert WhatsAppAdapter.renders_custom_url_schemes is False
        assert WhatsAppAdapter.keeps_quiet_unless_listening is False

    def test_one_meta_app_is_claimed_once_whatever_its_number(self) -> None:
        assert WhatsAppAdapter.claimed_workspace(dict(CONFIG)) == (
            f"WhatsApp Meta app {APP_ID}"
        )
        assert WhatsAppAdapter.claimed_workspace(
            {**CONFIG, "phone_number_id": "999"}
        ) == WhatsAppAdapter.claimed_workspace(dict(CONFIG))


# ── Connection config ─────────────────────────────────────────────────────────


class TestTheConnectForm:
    def test_a_complete_config_parses_with_whitespace_trimmed(self) -> None:
        config = WhatsAppConnectionConfig.model_validate(
            {**CONFIG, "access_token": "  EAAtest-token\n"}
        )
        assert config.access_token == "EAAtest-token"
        assert config.phone_number_id == PHONE_NUMBER_ID

    @pytest.mark.parametrize("field", sorted(CONFIG))
    def test_a_missing_field_is_refused(self, field: str) -> None:
        values = {k: v for k, v in CONFIG.items() if k != field}
        with pytest.raises(ValidationError) as caught:
            WhatsAppConnectionConfig.model_validate(values)
        assert field in str(caught.value)

    @pytest.mark.parametrize("field", sorted(CONFIG))
    def test_a_blank_field_is_refused_by_name(self, field: str) -> None:
        with pytest.raises(ValidationError) as caught:
            WhatsAppConnectionConfig.model_validate({**CONFIG, field: "   "})
        assert f"{field} is empty" in str(caught.value)

    def test_a_phone_number_in_place_of_its_id_is_refused(self) -> None:
        with pytest.raises(ValidationError) as caught:
            WhatsAppConnectionConfig.model_validate(
                {**CONFIG, "phone_number_id": "+1 555 078 3881"}
            )
        assert "not the phone number itself" in str(caught.value)

    def test_an_app_name_in_place_of_its_id_is_refused(self) -> None:
        with pytest.raises(ValidationError) as caught:
            WhatsAppConnectionConfig.model_validate({**CONFIG, "app_id": "Acme Bot"})
        assert "numeric App ID" in str(caught.value)

    def test_a_refused_value_is_not_echoed_back(self) -> None:
        with pytest.raises(ValidationError) as caught:
            WhatsAppConnectionConfig.model_validate(
                {**CONFIG, "phone_number_id": "secret-looking-value"}
            )
        assert "secret-looking-value" not in str(caught.value)

    def test_every_field_tells_the_operator_where_to_find_it(self) -> None:
        schema = WhatsAppConnectionConfig.model_json_schema()
        assert sorted(schema["required"]) == sorted(CONFIG)
        for field in CONFIG:
            assert schema["properties"][field]["title"]
            assert schema["properties"][field]["description"]


# ── Credentials and failures ──────────────────────────────────────────────────


def token_described(app_id: str = APP_ID, *, is_valid: bool = True) -> Handler:
    data: dict[str, Any] = {
        "app_id": app_id,
        "type": "SYSTEM_USER",
        "is_valid": is_valid,
    }
    if not is_valid:
        data["error"] = {"code": 190, "message": "Session has expired"}
    return lambda r: httpx.Response(200, json={"data": data})


def phone_number_read(r: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "display_phone_number": "+1 555-078-3881",
            "verified_name": "Acme",
            "id": PHONE_NUMBER_ID,
        },
    )


class TestCredentialsAreCheckedBeforeSaving:
    async def test_good_credentials_pass_with_the_app_secret_proved(
        self, graph: FakeGraph
    ) -> None:
        graph.on("GET", f"{API}/debug_token", token_described())
        graph.on("GET", f"{API}/{PHONE_NUMBER_ID}", phone_number_read)

        await WhatsAppAdapter.verify_credentials(dict(CONFIG))

        described, read = graph.requests
        assert described.url.params["input_token"] == CONFIG["access_token"]
        assert described.headers["authorization"] == (
            f"Bearer {APP_ID}|{CONFIG['app_secret']}"
        )
        assert read.headers["authorization"] == f"Bearer {CONFIG['access_token']}"
        assert read.url.params["appsecret_proof"] == PROOF

    async def test_a_token_from_another_app_is_refused(self, graph: FakeGraph) -> None:
        graph.on("GET", f"{API}/debug_token", token_described("999"))
        graph.on("GET", f"{API}/{PHONE_NUMBER_ID}", phone_number_read)

        with pytest.raises(BridgeCredentialError) as caught:
            await WhatsAppAdapter.verify_credentials(dict(CONFIG))

        assert f"issued for Meta app 999, not app {APP_ID}" in str(caught.value)

    async def test_an_expired_token_fails_with_metas_explanation(
        self, graph: FakeGraph
    ) -> None:
        graph.on("GET", f"{API}/debug_token", token_described(is_valid=False))

        with pytest.raises(BridgeCredentialError) as caught:
            await WhatsAppAdapter.verify_credentials(dict(CONFIG))

        assert "Session has expired" in str(caught.value)

    async def test_a_wrong_app_secret_fails_with_metas_explanation(
        self, graph: FakeGraph
    ) -> None:
        graph.on(
            "GET",
            f"{API}/debug_token",
            lambda r: graph_refusal(400, 101, "Error validating client secret."),
        )

        with pytest.raises(BridgeCredentialError) as caught:
            await WhatsAppAdapter.verify_credentials(dict(CONFIG))

        assert "Error validating client secret" in str(caught.value)
        assert "code 101" in str(caught.value)

    async def test_a_number_the_token_cannot_reach_fails_with_metas_explanation(
        self, graph: FakeGraph
    ) -> None:
        graph.on("GET", f"{API}/debug_token", token_described())
        graph.on(
            "GET",
            f"{API}/{PHONE_NUMBER_ID}",
            lambda r: graph_refusal(
                400, 100, "Unsupported get request. Object does not exist"
            ),
        )

        with pytest.raises(BridgeCredentialError) as caught:
            await WhatsAppAdapter.verify_credentials(dict(CONFIG))

        assert "Object does not exist" in str(caught.value)
        assert "code 100" in str(caught.value)

    async def test_an_unreachable_graph_fails_saying_so(self, graph: FakeGraph) -> None:
        def down(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        graph.on("GET", f"{API}/debug_token", down)

        with pytest.raises(BridgeCredentialError, match="Could not reach"):
            await WhatsAppAdapter.verify_credentials(dict(CONFIG))


class TestFailuresAreClassified:
    def _graph_error(self, status: int, code: int) -> WhatsAppGraphError:
        return graph_error(graph_refusal(status, code, "refused"))

    def test_a_rejected_token_is_an_auth_failure(self) -> None:
        assert WhatsAppAdapter.classify_failure(self._graph_error(401, 190)) == (
            "auth_failed"
        )
        assert WhatsAppAdapter.classify_failure(self._graph_error(400, 190)) == (
            "auth_failed"
        )

    def test_an_unreachable_graph_is_the_network(self) -> None:
        request = httpx.Request("POST", "https://graph.facebook.com/")
        assert WhatsAppAdapter.classify_failure(
            httpx.ConnectError("refused", request=request)
        ) == ("network")

    def test_any_other_refusal_is_the_platforms(self) -> None:
        assert WhatsAppAdapter.classify_failure(self._graph_error(400, 131026)) == (
            "platform_error"
        )

    def test_anything_else_is_left_to_switch(self) -> None:
        assert WhatsAppAdapter.classify_failure(ValueError("x")) is None
        assert WhatsAppAdapter.classify_failure(BridgeOperationError("x")) is None


class TestStarting:
    async def test_without_a_public_address_it_refuses_to_start(
        self, graph: FakeGraph
    ) -> None:
        adapter = WhatsAppAdapter(
            config=WhatsAppConnectionConfig.model_validate(CONFIG)
        )

        async def ignore(_: Any) -> None:
            return None

        with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
            await adapter.start(ignore, ignore, ignore, ignore, ignore)
        await adapter.stop()
        assert graph.requests == []


# ── Webhooks ──────────────────────────────────────────────────────────────────


class TestWebhooksProveThemselves:
    async def test_a_correctly_signed_post_is_accepted(
        self, adapter: WhatsAppAdapter
    ) -> None:
        await adapter.verify_webhook(post(text("wamid.in1", "hi")))

    async def test_a_post_signed_with_another_secret_is_refused(
        self, adapter: WhatsAppAdapter
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(post(text("wamid.in1", "hi"), "other"))

    async def test_a_post_with_no_signature_is_refused(
        self, adapter: WhatsAppAdapter
    ) -> None:
        request = post(text("wamid.in1", "hi"))
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(method="POST", headers={}, query={}, body=request.body)
            )

    async def test_a_body_changed_after_signing_is_refused(
        self, adapter: WhatsAppAdapter
    ) -> None:
        request = post(text("wamid.in1", "hi"))
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(
                    method="POST",
                    headers=request.headers,
                    query={},
                    body=request.body.replace(b"hi", b"ho"),
                )
            )

    async def test_the_address_check_is_answered_with_its_challenge(
        self, adapter: WhatsAppAdapter
    ) -> None:
        request = WebhookRequest(
            method="GET",
            headers={},
            query={
                "hub.mode": "subscribe",
                "hub.verify_token": CONFIG["verify_token"],
                "hub.challenge": "1158201444",
            },
            body=b"",
        )

        await adapter.verify_webhook(request)
        event = adapter.parse_webhook(request)

        assert event.handshake == "1158201444"
        assert event.envelope_type == "address_check"
        assert event.answers_inline is False

    @pytest.mark.parametrize(
        "query",
        [
            {"hub.mode": "subscribe", "hub.verify_token": "wrong"},
            {"hub.mode": "unsubscribe", "hub.verify_token": CONFIG["verify_token"]},
            {},
        ],
    )
    async def test_an_address_check_without_this_verify_token_is_refused(
        self, adapter: WhatsAppAdapter, query: dict[str, str]
    ) -> None:
        with pytest.raises(WebhookAuthenticityError):
            await adapter.verify_webhook(
                WebhookRequest(
                    method="GET",
                    headers={},
                    query={**query, "hub.challenge": "1"},
                    body=b"",
                )
            )


class TestWebhooksAreRead:
    def test_a_retried_delivery_carries_the_same_event_id(
        self, adapter: WhatsAppAdapter
    ) -> None:
        first = adapter.parse_webhook(post(text("wamid.in1", "hi")))
        again = adapter.parse_webhook(post(text("wamid.in1", "hi")))

        assert first.envelope_type == "message"
        assert first.external_event_id == again.external_event_id == "wamid.in1"
        assert first.answers_inline is False

    def test_a_status_is_identified_by_its_message_and_state(
        self, adapter: WhatsAppAdapter
    ) -> None:
        event = adapter.parse_webhook(
            post(
                envelope(
                    {
                        "statuses": [
                            {
                                "id": "wamid.out1",
                                "status": "delivered",
                                "timestamp": "1761700000",
                                "recipient_id": PERSON,
                            }
                        ]
                    }
                )
            )
        )
        assert event.envelope_type == "status"
        assert event.external_event_id == "wamid.out1:delivered"

    @pytest.mark.parametrize(
        "body",
        [
            b"not json",
            json.dumps({"object": "page", "entry": []}).encode(),
            json.dumps({"object": "whatsapp_business_account", "entry": []}).encode(),
            json.dumps(
                {"object": "whatsapp_business_account", "entry": [{"changes": []}]}
            ).encode(),
            json.dumps(envelope({"messages": [{"type": "text"}]})).encode(),
        ],
    )
    def test_a_body_that_is_not_a_whatsapp_event_is_refused(
        self, adapter: WhatsAppAdapter, body: bytes
    ) -> None:
        with pytest.raises(WebhookPayloadError):
            adapter.parse_webhook(
                WebhookRequest(method="POST", headers={}, query={}, body=body)
            )

    async def test_a_field_this_bridge_does_not_read_is_accepted_and_ignored_loudly(
        self,
        adapter: WhatsAppAdapter,
        heard: Heard,
        graph: FakeGraph,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        payload = envelope({"phone_number": BUSINESS_NUMBER, "event": "VERIFIED"})
        payload["entry"][0]["changes"][0]["field"] = "account_update"

        event = adapter.parse_webhook(post(payload))
        with caplog.at_level(logging.WARNING):
            await adapter.dispatch_event(
                envelope_type=event.envelope_type, payload=event.payload
            )

        assert event.external_event_id is None
        assert "account_update" in caplog.text
        assert heard.messages == [] and graph.requests == []


# ── Inbound ───────────────────────────────────────────────────────────────────


class TestInboundMessages:
    async def test_a_text_message_reaches_the_room_side_as_written(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        await deliver(adapter, text("wamid.in1", "*urgent*: ~old~ plan"))

        (message,) = heard.messages
        assert message.channel_id == PERSON
        assert message.channel_type == "direct"
        assert message.sender_id == PERSON
        assert message.sender_name == f"AdaLovelace_{PERSON}"
        assert message.channel_name == "Ada Lovelace"
        assert message.content == "*urgent*: ~old~ plan"
        assert adapter.translate_inbound(message.content) == (
            "**urgent**: ~~old~~ plan"
        )
        assert message.message_ref == "wamid.in1"
        assert message.root_id is None
        assert graph.receipts() == [
            {
                "messaging_product": "whatsapp",
                "status": "read",
                "message_id": "wamid.in1",
            }
        ]

    async def test_a_quote_reply_carries_the_quoted_message_as_its_root(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter,
            text(
                "wamid.in2",
                "A1 approve",
                context={"from": BUSINESS_NUMBER, "id": "wamid.out7"},
            ),
        )
        assert heard.messages[0].root_id == "wamid.out7"

    async def test_a_photo_is_downloaded_in_two_steps(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        graph.on(
            "GET",
            f"{API}/media-1",
            lambda r: httpx.Response(
                200,
                json={
                    "url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
                    "mime_type": "image/jpeg",
                    "file_size": 4,
                    "id": "media-1",
                },
            ),
        )
        graph.on(
            "GET",
            "/whatsapp_business/attachments/",
            lambda r: httpx.Response(200, content=b"\xff\xd8\xff\xe0"),
        )

        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.in3",
                    "type": "image",
                    "image": {
                        "caption": "the *receipt*",
                        "mime_type": "image/jpeg",
                        "sha256": "abc",
                        "id": "media-1",
                    },
                }
            ),
        )

        (message,) = heard.messages
        assert message.content == "the *receipt*"
        (attachment,) = message.attachments
        assert attachment.data == b"\xff\xd8\xff\xe0"
        assert attachment.mimetype == "image/jpeg"
        assert attachment.filename.startswith("image_media-1")
        download = next(
            r for r in graph.requests if r.url.host == "lookaside.fbsbx.com"
        )
        assert download.headers["authorization"] == f"Bearer {CONFIG['access_token']}"
        assert "appsecret_proof" not in download.url.params
        graph_calls = [r for r in graph.requests if r.url.host == "graph.facebook.com"]
        assert graph_calls
        assert all(r.url.params["appsecret_proof"] == PROOF for r in graph_calls)

    async def test_an_oversized_file_is_disclosed_and_not_downloaded(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        adapter.set_max_attachment_bytes(1000)
        graph.on(
            "GET",
            f"{API}/media-2",
            lambda r: httpx.Response(
                200,
                json={"url": "https://lookaside.fbsbx.com/x", "file_size": 5000},
            ),
        )

        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.in4",
                    "type": "document",
                    "document": {
                        "filename": "report.pdf",
                        "mime_type": "application/pdf",
                        "id": "media-2",
                    },
                }
            ),
        )

        (message,) = heard.messages
        assert message.attachments == []
        (failure,) = message.attachment_failures
        assert failure.filename == "report.pdf"
        assert "5000 bytes exceeds the 1000 byte limit" in failure.reason
        assert all(r.url.host != "lookaside.fbsbx.com" for r in graph.requests)

    async def test_a_file_that_cannot_be_downloaded_is_disclosed(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        graph.on(
            "GET",
            f"{API}/media-3",
            lambda r: graph_refusal(400, 131052, "Media download error"),
        )

        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.in5",
                    "type": "audio",
                    "audio": {"mime_type": "audio/ogg", "id": "media-3", "voice": True},
                }
            ),
        )

        (failure,) = heard.messages[0].attachment_failures
        assert "Media download error" in failure.reason

    async def test_a_location_is_described_rather_than_dropped(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.in6",
                    "type": "location",
                    "location": {
                        "latitude": 51.5,
                        "longitude": -0.12,
                        "name": "Office",
                    },
                }
            ),
        )
        assert "shared a location: Office" in heard.messages[0].content
        assert "51.5,-0.12" in heard.messages[0].content

    async def test_an_unsupported_message_is_disclosed(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.in7",
                    "type": "unsupported",
                    "errors": [{"code": 131051, "title": "Message type unknown"}],
                }
            ),
        )
        assert "does not deliver to businesses" in heard.messages[0].content

    async def test_a_bang_command_is_a_command(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(adapter, text("wamid.in8", "!invite-agent reviewer"))

        assert heard.messages == []
        (command,) = heard.commands
        assert (command.command, command.args) == ("invite-agent", "reviewer")
        assert command.channel_id == PERSON
        assert command.message_ref == "wamid.in8"

    async def test_a_person_with_a_username_is_addressed_by_their_scoped_id(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        payload = envelope(
            {
                "contacts": [
                    {
                        "user_id": "US.13491208655302741918",
                        "profile": {"username": "@ada"},
                    }
                ],
                "messages": [
                    {
                        "from_user_id": "US.13491208655302741918",
                        "id": "wamid.in9",
                        "timestamp": "1761700000",
                        "type": "text",
                        "text": {"body": "hello"},
                    }
                ],
            }
        )

        await deliver(adapter, payload)
        await adapter.send_message("US.13491208655302741918", "helper", "hi")

        assert heard.messages[0].channel_id == "US.13491208655302741918"
        assert heard.messages[0].channel_name == "ada"
        (sent,) = graph.sends()
        assert sent["recipient"] == "US.13491208655302741918"
        assert "to" not in sent

    async def test_a_status_callback_dispatches_nothing(
        self, adapter: WhatsAppAdapter, heard: Heard, graph: FakeGraph
    ) -> None:
        await deliver(
            adapter,
            envelope(
                {
                    "statuses": [
                        {
                            "id": "wamid.out1",
                            "status": "read",
                            "timestamp": "1761700000",
                            "recipient_id": PERSON,
                        }
                    ]
                }
            ),
        )
        assert heard.messages == [] and heard.commands == []
        assert graph.requests == []

    async def test_a_send_refused_later_for_the_window_is_said_loudly(
        self,
        adapter: WhatsAppAdapter,
        heard: Heard,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.ERROR):
            await deliver(
                adapter,
                envelope(
                    {
                        "statuses": [
                            {
                                "id": "wamid.out2",
                                "status": "failed",
                                "timestamp": "1761700000",
                                "recipient_id": PERSON,
                                "errors": [
                                    {
                                        "code": 131047,
                                        "title": "Re-engagement message",
                                        "message": "Re-engagement message",
                                    }
                                ],
                            }
                        ]
                    }
                ),
            )
        assert heard.messages == []
        assert WINDOW_CLOSED in caplog.text
        assert "wamid.out2" in caplog.text

    async def test_the_business_numbers_own_message_is_ignored(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter, text("wamid.echo", "our own words", sender=BUSINESS_NUMBER)
        )
        assert heard.messages == []

    async def test_a_group_message_is_ignored(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter, text("wamid.g1", "hi all", group_id="120363000000000000")
        )
        assert heard.messages == []

    async def test_a_reaction_is_not_relayed_as_a_message(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        await deliver(
            adapter,
            inbound(
                {
                    "id": "wamid.r1",
                    "type": "reaction",
                    "reaction": {"message_id": "wamid.out1", "emoji": "👍"},
                }
            ),
        )
        assert heard.messages == []

    async def test_another_numbers_event_is_ignored(
        self, adapter: WhatsAppAdapter, heard: Heard
    ) -> None:
        payload = text("wamid.in10", "hi")
        payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = (
            "999"
        )
        await deliver(adapter, payload)
        assert heard.messages == []


# ── Outbound ──────────────────────────────────────────────────────────────────


class TestOutboundMessages:
    async def test_a_reply_posts_under_the_agents_name_and_returns_the_wamid(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        ref = await adapter.send_message(
            PERSON, "helper", adapter.translate_outbound("Done: **3** files")
        )

        assert ref == "wamid.out1"
        (request,) = graph.requests
        assert request.url.path == f"{API}/{PHONE_NUMBER_ID}/messages"
        assert request.headers["authorization"] == f"Bearer {CONFIG['access_token']}"
        assert json.loads(request.content) == {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": PERSON,
            "type": "text",
            "text": {"body": "*helper*: Done: *3* files", "preview_url": False},
        }

    async def test_a_threaded_reply_quotes_the_message_it_answers(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        await adapter.send_message(PERSON, "helper", "yes", "wamid.in1")
        assert graph.sends()[0]["context"] == {"message_id": "wamid.in1"}

    async def test_a_thread_that_is_not_a_whatsapp_message_is_not_quoted(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        await adapter.send_message(PERSON, "helper", "yes", "turn:t-1")
        assert "context" not in graph.sends()[0]

    async def test_a_long_reply_is_split_and_the_first_part_is_its_ref(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        paragraph = "word " * 500
        body = "\n\n".join([paragraph.strip()] * 4)

        ref = await adapter.send_message(PERSON, "helper", body, "wamid.in1")

        sent = graph.sends()
        assert ref == "wamid.out1"
        assert len(sent) > 1
        assert all(len(s["text"]["body"]) <= 4096 for s in sent)
        assert sent[0]["context"] == {"message_id": "wamid.in1"}
        assert all("context" not in s for s in sent[1:])
        assert all(s["text"]["body"].endswith("word") for s in sent)

    async def test_outside_the_24_hour_window_the_send_fails_saying_why(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        graph.on(
            "POST",
            f"{API}/{PHONE_NUMBER_ID}/messages",
            lambda r: graph_refusal(400, 131047, "(#131047) Re-engagement message"),
        )

        with pytest.raises(BridgeOperationError) as caught:
            await adapter.send_message(PERSON, "helper", "late reply")

        assert str(caught.value) == WINDOW_CLOSED
        assert "24 hours" in WINDOW_CLOSED and "template" in WINDOW_CLOSED

    async def test_any_other_refusal_is_raised_as_whatsapps(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        graph.on(
            "POST",
            f"{API}/{PHONE_NUMBER_ID}/messages",
            lambda r: graph_refusal(400, 131026, "Message undeliverable"),
        )
        with pytest.raises(WhatsAppGraphError) as caught:
            await adapter.send_message(PERSON, "helper", "hi")
        assert caught.value.code == 131026

    async def test_edits_and_deletes_reach_nothing(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        await adapter.update_message(PERSON, "wamid.out1", "changed")
        await adapter.delete_message(PERSON, "wamid.out1")
        assert graph.requests == []


class TestOutboundFiles:
    def _upload_answers(self, graph: FakeGraph) -> None:
        graph.on(
            "POST",
            f"{API}/{PHONE_NUMBER_ID}/media",
            lambda r: httpx.Response(200, json={"id": "uploaded-1"}),
        )

    async def test_a_photo_is_uploaded_then_sent_with_its_caption(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        self._upload_answers(graph)

        ref = await adapter.send_attachment(
            PERSON, "helper", "chart.png", "image/png", b"\x89PNG", "the **chart**"
        )

        upload, send = graph.requests
        assert upload.url.path == f"{API}/{PHONE_NUMBER_ID}/media"
        assert upload.url.params["appsecret_proof"] == PROOF
        assert send.url.params["appsecret_proof"] == PROOF
        assert b'name="messaging_product"' in upload.content
        assert b'filename="chart.png"' in upload.content
        assert b"\x89PNG" in upload.content
        assert json.loads(send.content)["image"] == {
            "id": "uploaded-1",
            "caption": "*helper*: the *chart*",
        }
        assert ref == "wamid.out1"

    async def test_a_document_keeps_its_filename(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        self._upload_answers(graph)
        await adapter.send_attachment(
            PERSON, "helper", "notes.txt", "text/plain", b"hello", None
        )
        assert graph.sends()[0]["document"] == {
            "id": "uploaded-1",
            "caption": "*helper*",
            "filename": "notes.txt",
        }

    async def test_audio_takes_its_caption_as_a_message_before_it(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        self._upload_answers(graph)
        ref = await adapter.send_attachment(
            PERSON, "helper", "memo.mp3", "audio/mpeg", b"ID3", "listen"
        )
        caption, audio = graph.sends()
        assert caption["text"]["body"] == "*helper*: listen"
        assert audio["audio"] == {"id": "uploaded-1"}
        assert ref == "wamid.out1"

    async def test_an_oversized_file_is_refused_visibly_in_the_chat(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        ref = await adapter.send_attachment(
            PERSON,
            "helper",
            "demo.mp4",
            "video/mp4",
            b"\x00" * (MAX_VIDEO_BYTES + 1),
            None,
        )

        assert all(not r.url.path.endswith("/media") for r in graph.requests)
        (notice,) = graph.sends()
        body = notice["text"]["body"]
        assert "demo.mp4" in body
        assert "16.0 MB is over WhatsApp's 16.0 MB limit for video files" in body
        assert ref == "wamid.out1"

    async def test_a_file_whatsapp_refuses_is_named_in_the_chat(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        graph.on(
            "POST",
            f"{API}/{PHONE_NUMBER_ID}/media",
            lambda r: graph_refusal(400, 131053, "Media upload error"),
        )
        await adapter.send_attachment(
            PERSON, "helper", "clip.mp4", "video/mp4", b"\x00", None
        )
        (notice,) = graph.sends()
        assert "clip.mp4" in notice["text"]["body"]
        assert "Media upload error" in notice["text"]["body"]


class TestWorkingState:
    async def test_working_reacts_and_shows_typing_on_the_asking_message(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        await adapter.mark_activity(
            PERSON, "wamid.in1", agent_name="helper", mark="working", on=True
        )
        (reaction,) = graph.sends()
        assert reaction["type"] == "reaction"
        assert reaction["reaction"] == {"message_id": "wamid.in1", "emoji": "👀"}
        assert graph.receipts()[0]["typing_indicator"] == {"type": "text"}

    async def test_done_takes_the_reaction_off(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        await adapter.mark_activity(
            PERSON, "wamid.in1", agent_name="helper", mark="working", on=False
        )
        (reaction,) = graph.sends()
        assert reaction["reaction"] == {"message_id": "wamid.in1", "emoji": ""}
        assert graph.receipts() == []

    async def test_a_reaction_outside_the_window_is_refused_for_good(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        graph.on(
            "POST",
            f"{API}/{PHONE_NUMBER_ID}/messages",
            lambda r: graph_refusal(400, 131047, "Re-engagement message"),
        )
        with pytest.raises(ActivityMarkRefused):
            await adapter.mark_activity(
                PERSON, "wamid.in1", agent_name="helper", mark="working", on=True
            )

    async def test_a_turn_is_not_posted_as_a_message(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-1", status="running", command_id=None
        )
        ref = await adapter.post_rich(PERSON, "helper", TurnActivity([], turn))
        await adapter.update_rich(PERSON, "helper", ref, TurnActivity([], turn), None)

        assert ref == "turn:t-1"
        assert graph.requests == []

    async def test_a_problem_somebody_has_to_act_on_is_posted(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
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
        assert ref == "wamid.out1"
        body = graph.sends()[0]["text"]["body"]
        assert body.startswith("*helper*")
        assert "Agent went offline" in body

    async def test_an_offline_host_is_not_announced_as_working(
        self, adapter: WhatsAppAdapter, graph: FakeGraph
    ) -> None:
        turn = TurnUpsert(
            type="turn.upsert", turn_id="t-3", status="running", command_id=None
        )
        await adapter.post_rich(
            PERSON,
            "helper",
            TurnActivity(
                [],
                turn,
                status_only=True,
                error_summary="The agent host is offline.",
            ),
        )
        body = graph.sends()[0]["text"]["body"]
        assert "The agent host is offline." in body
        assert "Working" not in body


class TestChannels:
    async def test_whatsapp_chats_are_one_to_one_and_cannot_be_created(
        self, adapter: WhatsAppAdapter
    ) -> None:
        assert await adapter.get_channel_type(PERSON) == "direct"
        assert await adapter.get_channel_agent_names(PERSON) == []
        with pytest.raises(ChannelCreationUnsupported):
            await adapter.create_channel("room", "topic")

    async def test_nobody_else_can_be_added_and_they_are_named(
        self, adapter: WhatsAppAdapter
    ) -> None:
        assert await adapter.add_users_to_channel(PERSON, ["bob"], ["u-2"]) == ["u-2"]
