"""The WhatsApp adapter against a stand-in for the Cloud API."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from switch_core.bridges.collaboration.adapter import RequestCard
from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import (
    BridgeOperationError,
    ChannelCreationUnsupported,
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    parse_answer_position,
)
from switch_core.bridges.collaboration.whatsapp.adapter import (
    SIGNATURE_HEADER,
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
    WhatsAppError,
    sign,
    to_whatsapp,
)

from .session_fixtures import open_request

NUMBER_ID = "1234567890"
SECRET = "app-secret"
VERIFY = "a-long-verify-token"
ADA = "447700900123"
URL = "https://switch.example.test/messaging/bridges/b1/events"


class FakeGraph:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.refuse: tuple[int, int] | None = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.sent.append(body)
        if self.refuse:
            status, code = self.refuse
            return httpx.Response(
                status, json={"error": {"code": code, "message": "refused"}}
            )
        return httpx.Response(
            200, json={"messages": [{"id": f"wamid.out{len(self.sent)}"}]}
        )


@pytest.fixture
def graph() -> FakeGraph:
    return FakeGraph()


@pytest.fixture
async def adapter(graph: FakeGraph) -> WhatsAppAdapter:
    adapter = WhatsAppAdapter(
        config=WhatsAppConnectionConfig(
            phone_number_id=NUMBER_ID,
            access_token="token",
            app_secret=SECRET,
            verify_token=VERIFY,
        )
    )
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(graph.handle))
    received: list[Any] = []

    async def keep(item: Any) -> None:
        received.append(item)

    adapter.set_webhook_url(URL)
    await adapter.start(keep, keep, keep, keep, keep)
    adapter.set_interaction_handler(keep)
    adapter.received = received  # type: ignore[attr-defined]
    return adapter


def _change(message: dict[str, Any]) -> bytes:
    value = {
        "contacts": [{"wa_id": ADA, "profile": {"name": "Ada"}}],
        "messages": [{"from": ADA, "id": "wamid.in1", **message}],
    }
    return json.dumps({"entry": [{"changes": [{"value": value}]}]}).encode()


def _post(body: bytes, secret: str = SECRET) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: sign(secret, body)},
        query={},
        body=body,
    )


async def _deliver(adapter: WhatsAppAdapter, body: bytes) -> None:
    hook = adapter.parse_webhook(_post(body))
    await adapter.dispatch_event(envelope_type=hook.envelope_type, payload=hook.payload)


def test_a_config_it_cannot_use_is_refused() -> None:
    with pytest.raises(ValidationError, match="digits"):
        WhatsAppConnectionConfig(
            phone_number_id="+44 7700",
            access_token="t",
            app_secret="s",
            verify_token=VERIFY,
        )
    with pytest.raises(ValidationError):
        WhatsAppConnectionConfig(
            phone_number_id=NUMBER_ID,
            access_token="t",
            app_secret="s",
            verify_token="short",
        )


async def test_the_address_check_echoes_its_challenge(adapter: WhatsAppAdapter) -> None:
    query = {"hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "42"}
    request = WebhookRequest(method="GET", headers={}, query=query, body=b"")
    await adapter.verify_webhook(request)
    assert adapter.parse_webhook(request).handshake == "42"
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(
            WebhookRequest(
                method="GET",
                headers={},
                query={**query, "hub.verify_token": "x"},
                body=b"",
            )
        )


async def test_a_signed_event_is_taken_and_another_secret_refused(
    adapter: WhatsAppAdapter,
) -> None:
    body = _change({"type": "text", "text": {"body": "hi"}})
    await adapter.verify_webhook(_post(body))
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_post(body, "another-secret"))
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(_post(b"{}"))


def test_a_retried_event_carries_the_message_id(adapter: WhatsAppAdapter) -> None:
    body = _change({"type": "text", "text": {"body": "hi"}})
    assert adapter.parse_webhook(_post(body)).external_event_id == "wamid.in1"


async def test_a_text_is_a_direct_room_and_a_quote_reply_its_thread(
    adapter: WhatsAppAdapter,
) -> None:
    await _deliver(
        adapter,
        _change(
            {
                "type": "text",
                "text": {"body": "@coder hi"},
                "context": {"id": "wamid.root"},
            }
        ),
    )
    [message] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(message, InboundMessage)
    assert (message.channel_id, message.channel_type, message.sender_name) == (
        ADA,
        "direct",
        "Ada",
    )
    assert (message.content, message.root_id) == ("@coder hi", "wamid.root")


async def test_a_bang_command(adapter: WhatsAppAdapter) -> None:
    await _deliver(adapter, _change({"type": "text", "text": {"body": "!help"}}))
    [command] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(command, InboundCommand) and command.command == "help"


async def test_a_button_reply_is_an_interaction(adapter: WhatsAppAdapter) -> None:
    reply = {"button_reply": {"id": "switch:answer:2|tok", "title": "2. No"}}
    await _deliver(
        adapter,
        _change(
            {
                "type": "interactive",
                "interactive": reply,
                "context": {"id": "wamid.card"},
            }
        ),
    )
    [press] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(press, InboundInteraction)
    assert (press.action_id, press.value, press.message_ref) == (
        "switch:answer:2",
        "tok",
        "wamid.card",
    )


async def test_a_status_update_reaches_no_room(adapter: WhatsAppAdapter) -> None:
    body = json.dumps(
        {"entry": [{"changes": [{"value": {"statuses": [{"id": "x"}]}}]}]}
    ).encode()
    hook = adapter.parse_webhook(_post(body))
    assert hook.external_event_id is None
    await adapter.dispatch_event(envelope_type=hook.envelope_type, payload=hook.payload)
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_reply_names_the_agent_and_quotes_the_thread(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    await adapter.send_message(
        ADA, "coder", adapter.translate_outbound("**done**"), "wamid.root"
    )
    [sent] = graph.sent
    assert sent["to"] == ADA and sent["text"]["body"] == "*coder*\n*done*"
    assert sent["context"] == {"message_id": "wamid.root"}


async def test_outside_the_24_hour_window_the_refusal_says_so(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    graph.refuse = (400, 131047)
    with pytest.raises(BridgeOperationError, match="24 hours"):
        await adapter.send_message(ADA, "coder", "late")


async def test_a_card_with_few_options_has_reply_buttons(
    adapter: WhatsAppAdapter, graph: FakeGraph
) -> None:
    card = RequestCard(open_request(), RequestReference(token="tok", handle="R1"))
    await adapter.post_rich(ADA, "coder", card)
    [sent] = graph.sent
    buttons = sent["interactive"]["action"]["buttons"]
    assert 0 < len(buttons) <= 3
    ids = [b["reply"]["id"].split("|") for b in buttons]
    assert all(token == "tok" for _, token in ids)
    assert [parse_answer_position(a) for a, _ in ids] == list(range(1, len(ids) + 1))
    assert all(len(b["reply"]["title"]) <= 20 for b in buttons)


async def test_there_is_no_group_to_create(adapter: WhatsAppAdapter) -> None:
    with pytest.raises(ChannelCreationUnsupported):
        await adapter.create_channel("room", "topic")


def test_markdown_in_whatsapps_marks() -> None:
    assert (
        to_whatsapp("# Plan\n**bold** ~~old~~ [docs](https://x.test)")
        == "*Plan*\n*bold* ~old~ docs (https://x.test)"
    )


def test_failures_are_classified() -> None:
    assert (
        WhatsAppAdapter.classify_failure(WhatsAppError(401, 190, "no")) == "auth_failed"
    )
    assert (
        WhatsAppAdapter.classify_failure(WhatsAppError(400, 100, "no"))
        == "platform_error"
    )
    assert WhatsAppAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert (
        WhatsAppAdapter.claimed_workspace({"phone_number_id": NUMBER_ID})
        == f"whatsapp {NUMBER_ID}"
    )
