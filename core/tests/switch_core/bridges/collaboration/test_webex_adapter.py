from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, cast

import httpx
import pytest

from switch_core.bridges.collaboration.install import (
    WebhookAuthenticityError,
    WebhookRequest,
)
from switch_core.bridges.collaboration.models import InboundCommand, InboundMessage
from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
    _chunks,
)
from switch_core.bridges.collaboration.webex.client import WebexApiError, WebexClient


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.current: dict[str, Any] = {
            "id": "m1",
            "roomId": "r1",
            "personId": "p1",
            "personEmail": "ada@example.com",
            "text": "hello",
        }

    async def message(self, message_id: str) -> dict[str, Any]:
        self.calls.append(("message", message_id))
        return self.current

    async def send(self, room_id: str, markdown: str, parent_id: str | None) -> str:
        self.calls.append(("send", (room_id, markdown, parent_id)))
        return f"sent-{len(self.calls)}"

    async def update(self, message_id: str, room_id: str, markdown: str) -> None:
        self.calls.append(("update", (message_id, room_id, markdown)))

    async def delete(self, message_id: str) -> None:
        self.calls.append(("delete", message_id))

    async def download(self, url: str) -> tuple[bytes, str]:
        return b"file", "text/plain"

    async def create_room(self, title: str) -> str:
        return "new-room"

    async def room(self, room_id: str) -> dict[str, Any]:
        return {"id": room_id, "type": "group"}

    async def add_member(self, room_id: str, person: str) -> None:
        if person == "bad":
            raise WebexApiError(400, "bad member")


def adapter() -> WebexAdapter:
    value = WebexAdapter(
        config=WebexConnectionConfig(
            bot_access_token="token", webhook_secret="0123456789abcdef"
        )
    )
    value._client = cast(WebexClient, FakeClient())
    value._bot_id = "bot"
    return value


def webhook(payload: dict[str, Any], *, valid: bool = True) -> WebhookRequest:
    body = json.dumps(payload, separators=(",", ":")).encode()
    signature = hmac.new(b"0123456789abcdef", body, hashlib.sha1).hexdigest()
    if not valid:
        signature = "0" * 40
    return WebhookRequest(
        method="POST", headers={"x-spark-signature": signature}, query={}, body=body
    )


@pytest.mark.asyncio
async def test_webhook_signature_is_raw_body_hmac() -> None:
    value = adapter()
    await value.verify_webhook(webhook({"id": "e1", "data": {"id": "m1"}}))
    with pytest.raises(WebhookAuthenticityError):
        await value.verify_webhook(
            webhook({"id": "e1", "data": {"id": "m1"}}, valid=False)
        )


def test_webhook_event_id_is_deduplication_key() -> None:
    parsed = adapter().parse_webhook(
        webhook({"id": "event-1", "data": {"id": "message-1"}})
    )
    assert parsed.external_event_id == "event-1"
    assert parsed.payload == {"id": "message-1"}


@pytest.mark.asyncio
async def test_inbound_message_and_thread_are_dispatched() -> None:
    value = adapter()
    fake = cast(FakeClient, value._client)
    fake.current["parentId"] = "root"
    messages: list[InboundMessage] = []

    async def on_message(message: InboundMessage) -> None:
        messages.append(message)

    value._on_message = on_message
    await value.dispatch_event(envelope_type="message.created", payload={"id": "m1"})
    assert messages[0].root_id == "root"
    assert messages[0].sender_name == "ada@example.com"


@pytest.mark.asyncio
async def test_bot_echo_is_ignored_and_command_is_routed() -> None:
    value = adapter()
    fake = cast(FakeClient, value._client)
    messages: list[InboundMessage] = []
    value._on_message = messages.append  # type: ignore[assignment]
    fake.current["personId"] = "bot"
    await value.dispatch_event(envelope_type="message.created", payload={"id": "m1"})
    assert messages == []
    fake.current.update({"personId": "p1", "text": "!reset @helper"})
    commands: list[InboundCommand] = []

    async def on_command(command: InboundCommand) -> None:
        commands.append(command)

    value._on_command = on_command
    await value.dispatch_event(envelope_type="message.created", payload={"id": "m1"})
    assert commands[0].command == "reset"


def test_long_messages_split_on_boundaries() -> None:
    parts = _chunks("word " * 2000)
    assert len(parts) == 2
    assert all(len(part) <= 7000 for part in parts)


@pytest.mark.asyncio
async def test_outbound_preserves_parent_and_returns_first_ref() -> None:
    value = adapter()
    ref = await value.send_message("r1", "Ada", "hello", "root")
    assert ref == "sent-1"
    fake = cast(FakeClient, value._client)
    assert fake.calls[0][1][2] == "root"
    await value.update_message("r1", "m1", "new")
    await value.delete_message("r1", "m1")
    assert fake.calls[-2][0] == "update"
    assert fake.calls[-1] == ("delete", "m1")


@pytest.mark.asyncio
async def test_room_creation_and_partial_membership_failure() -> None:
    value = adapter()
    assert await value.create_channel("Project", "topic") == "new-room"
    failed = await value.add_users_to_channel(
        "r1", ["Ada", "Bad"], ["ada@example.com", "bad"]
    )
    assert failed == ["bad"]


@pytest.mark.asyncio
async def test_client_authorizes_and_sends_json() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "m1"})

    http = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        headers={"Authorization": "Bearer token"},
    )
    client = WebexClient(token="token", http=http)
    assert await client.send("r1", "hello", "root") == "m1"
    assert seen[0].headers["authorization"] == "Bearer token"
    assert json.loads(seen[0].content)["parentId"] == "root"
    await http.aclose()
