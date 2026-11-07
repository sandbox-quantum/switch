"""The Webex adapter against a stand-in for Webex's REST API."""

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
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.session.renderers import (
    RequestReference,
    parse_answer_position,
)
from switch_core.bridges.collaboration.webex.adapter import (
    SIGNATURE_HEADER,
    WebexAdapter,
    WebexConnectionConfig,
    WebexError,
    sign,
)

from .session_fixtures import open_request

TOKEN = "T" * 64
SECRET = "a-long-webhook-secret"
BOT = "bot-person-id"
ADA = "ada-person-id"
ROOM = "room-id"


class FakeWebex:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.message: dict[str, Any] = {
            "id": "msg-1",
            "roomId": ROOM,
            "roomType": "group",
            "personId": ADA,
            "personEmail": "ada@example.test",
            "text": "Switch Bot hello",
            "markdown": "Switch Bot hello",
            "mentionedPeople": [BOT],
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body))
        path = request.url.path
        if path == "/v1/people/me":
            return httpx.Response(
                200, json={"id": BOT, "displayName": "Switch Bot", "type": "bot"}
            )
        if path == "/v1/messages/msg-1":
            return httpx.Response(200, json=self.message)
        if path == "/v1/attachment/actions/act-1":
            return httpx.Response(
                200,
                json={
                    "roomId": ROOM,
                    "personId": ADA,
                    "messageId": "card-1",
                    "inputs": {
                        "switch_action": "switch:answer:1",
                        "switch_value": "tok",
                    },
                },
            )
        if path == "/v1/webhooks" and request.method == "GET":
            return httpx.Response(
                200, json={"items": [{"id": "old", "name": "Switch"}]}
            )
        if path == "/v1/messages" and request.method == "POST":
            if body and body.get("roomId") == "refused":
                return httpx.Response(403, json={"message": "not a member"})
            return httpx.Response(200, json={"id": f"out-{len(self.calls)}"})
        if path == f"/v1/rooms/{ROOM}":
            return httpx.Response(200, json={"type": "group"})
        return httpx.Response(200, json={})


@pytest.fixture
def webex() -> FakeWebex:
    return FakeWebex()


@pytest.fixture
async def adapter(webex: FakeWebex) -> WebexAdapter:
    adapter = WebexAdapter(
        config=WebexConnectionConfig(bot_token=TOKEN, webhook_secret=SECRET)
    )
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(webex.handle))
    received: list[Any] = []

    async def keep(item: Any) -> None:
        received.append(item)

    adapter.set_webhook_url("https://switch.example.test/messaging/bridges/b1/events")
    await adapter.start(keep, keep, keep, keep, keep)
    adapter.set_interaction_handler(keep)
    adapter.received = received  # type: ignore[attr-defined]
    return adapter


def _request(body: bytes, secret: str = SECRET) -> WebhookRequest:
    return WebhookRequest(
        method="POST",
        headers={SIGNATURE_HEADER: sign(secret, body)},
        query={},
        body=body,
    )


def _event(resource: str, item: str) -> bytes:
    return json.dumps(
        {
            "resource": resource,
            "event": "created",
            "data": {"id": item, "personId": ADA},
        }
    ).encode()


def test_a_config_it_cannot_use_is_refused() -> None:
    with pytest.raises(ValidationError, match="access token"):
        WebexConnectionConfig(bot_token="short", webhook_secret=SECRET)
    with pytest.raises(ValidationError):
        WebexConnectionConfig(bot_token=TOKEN, webhook_secret="short")


async def test_start_registers_its_webhooks_signed(
    adapter: WebexAdapter, webex: FakeWebex
) -> None:
    assert ("DELETE", "/v1/webhooks/old", None) in webex.calls
    made = [b for m, p, b in webex.calls if m == "POST" and p == "/v1/webhooks"]
    assert {b["resource"] for b in made} == {"messages", "attachmentActions"}
    assert all(
        b["secret"] == SECRET and b["targetUrl"].endswith("/events") for b in made
    )


async def test_without_a_public_address_start_says_so(webex: FakeWebex) -> None:
    adapter = WebexAdapter(
        config=WebexConnectionConfig(bot_token=TOKEN, webhook_secret=SECRET)
    )
    adapter._http = httpx.AsyncClient(transport=httpx.MockTransport(webex.handle))

    async def keep(item: Any) -> None:
        return None

    with pytest.raises(BridgeOperationError, match="MESSAGING_PUBLIC_URL"):
        await adapter.start(keep, keep, keep, keep, keep)


async def test_a_signed_event_is_taken_and_another_secret_refused(
    adapter: WebexAdapter,
) -> None:
    body = _event("messages", "msg-1")
    await adapter.verify_webhook(_request(body))
    with pytest.raises(WebhookAuthenticityError):
        await adapter.verify_webhook(_request(body, "another-secret-entirely"))


def test_a_retried_delivery_carries_the_same_event_id(adapter: WebexAdapter) -> None:
    body = _event("messages", "msg-1")
    first, again = (
        adapter.parse_webhook(_request(body)),
        adapter.parse_webhook(_request(body)),
    )
    assert first.external_event_id == again.external_event_id == "msg-1"
    assert first.envelope_type == "messages.created"
    with pytest.raises(WebhookPayloadError):
        adapter.parse_webhook(_request(b"{not json"))


async def test_a_mention_reaches_the_room_without_the_bots_name(
    adapter: WebexAdapter,
) -> None:
    hook = adapter.parse_webhook(_request(_event("messages", "msg-1")))
    await adapter.dispatch_event(envelope_type=hook.envelope_type, payload=hook.payload)
    [message] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(message, InboundMessage)
    assert (message.content, message.channel_id, message.channel_type) == (
        "hello",
        ROOM,
        "channel_private",
    )
    assert message.self_mention_token == BOT


async def test_a_bang_command_and_a_thread(
    adapter: WebexAdapter, webex: FakeWebex
) -> None:
    webex.message.update(markdown="Switch Bot !help", parentId="root-1")
    await adapter.dispatch_event(
        envelope_type="messages.created",
        payload={"data": {"id": "msg-1", "personId": ADA}},
    )
    [command] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(command, InboundCommand)
    assert (command.command, command.root_id) == ("help", "root-1")


async def test_the_bots_own_message_is_ignored(adapter: WebexAdapter) -> None:
    await adapter.dispatch_event(
        envelope_type="messages.created",
        payload={"data": {"id": "msg-1", "personId": BOT}},
    )
    assert adapter.received == []  # type: ignore[attr-defined]


async def test_a_card_submit_is_an_interaction(adapter: WebexAdapter) -> None:
    await adapter.dispatch_event(
        envelope_type="attachmentActions.created", payload={"data": {"id": "act-1"}}
    )
    [press] = adapter.received  # type: ignore[attr-defined]
    assert isinstance(press, InboundInteraction)
    assert (press.action_id, press.value, press.message_ref) == (
        "switch:answer:1",
        "tok",
        "card-1",
    )


async def test_a_reply_names_the_agent_and_stays_in_its_thread(
    adapter: WebexAdapter, webex: FakeWebex
) -> None:
    await adapter.send_message(ROOM, "coder", "done", "root-1")
    [body] = [b for m, p, b in webex.calls if m == "POST" and p == "/v1/messages"]
    assert body == {"roomId": ROOM, "markdown": "**coder**\ndone", "parentId": "root-1"}
    with pytest.raises(BridgeOperationError, match="not a member"):
        await adapter.send_message("refused", "coder", "x")


async def test_a_request_card_has_a_button_per_option(
    adapter: WebexAdapter, webex: FakeWebex
) -> None:
    card = RequestCard(open_request(), RequestReference(token="tok", handle="R1"))
    await adapter.post_rich(ROOM, "coder", card)
    [body] = [b for m, p, b in webex.calls if m == "POST" and p == "/v1/messages"]
    actions = body["attachments"][0]["content"]["actions"]
    assert actions and all(a["data"]["switch_value"] == "tok" for a in actions)
    positions = [parse_answer_position(a["data"]["switch_action"]) for a in actions]
    assert positions == list(range(1, len(actions) + 1))


def test_failures_are_classified() -> None:
    assert WebexAdapter.classify_failure(WebexError(401, "no")) == "auth_failed"
    assert WebexAdapter.classify_failure(WebexError(500, "no")) == "platform_error"
    assert WebexAdapter.classify_failure(httpx.ConnectError("down")) == "network"
    assert WebexAdapter.classify_failure(ValueError()) is None
