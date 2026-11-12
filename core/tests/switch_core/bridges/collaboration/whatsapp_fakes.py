"""Meta's side of WhatsApp, faked at the HTTP transport, and payloads in its shapes.

The adapter is driven exactly as the webhook route drives it: a signed request
is verified, parsed, then dispatched, and every call the adapter makes back to
Meta lands in `FakeMeta`, which answers the way the Cloud API does.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.install import WebhookRequest
from switch_core.bridges.collaboration.models import (
    InboundCommand,
    InboundInteraction,
    InboundMessage,
)
from switch_core.bridges.collaboration.whatsapp import adapter as adapter_module
from switch_core.bridges.collaboration.whatsapp.adapter import (
    WhatsAppAdapter,
    WhatsAppConnectionConfig,
)

APP_ID = "222222222"
PHONE_ID = "1111111111"
BUSINESS_NUMBER = "15550000000"
# A real delivery is recent; an old timestamp is how a replay looks.
NOW = str(int(time.time()))
CONTACT = "15551234567"
# How Meta names someone who has adopted a WhatsApp username.
CONTACT_BSUID = "US.13491208655302741918"
SECRET = "test-app-secret"
VERIFY = "test-verify-phrase"
WEBHOOK_URL = "https://switch.example/messaging/bridges/b-1/events"

CONFIG: dict[str, object] = {
    "access_token": "test-access-token",
    "app_secret": SECRET,
    "app_id": APP_ID,
    "phone_number_id": PHONE_ID,
    "verify_token": VERIFY,
}


class FakeMeta:
    """Answers Graph API calls and keeps every request the adapter made."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.refusals: dict[str, httpx.Response] = {}
        self.media: dict[str, tuple[str, bytes]] = {}
        self.media_host = "lookaside.fbsbx.com"
        self.hide_sizes = False
        self.token: dict[str, object] = {
            "app_id": APP_ID,
            "is_valid": True,
            "scopes": ["whatsapp_business_messaging", "whatsapp_business_management"],
        }
        self._sent = 0

    def refuse(self, path_suffix: str, status: int, code: int, message: str) -> None:
        self.refusals[path_suffix] = httpx.Response(
            status,
            json={
                "error": {"message": message, "type": "OAuthException", "code": code}
            },
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        for suffix, refusal in self.refusals.items():
            if path.endswith(suffix):
                return refusal
        if request.url.host not in ("graph.facebook.com", "lookaside.fbsbx.com"):
            return httpx.Response(200, content=b"not Meta")
        if request.url.host == "lookaside.fbsbx.com":
            return httpx.Response(200, content=self.media[request.url.params["mid"]][1])
        if path.endswith("/debug_token"):
            return httpx.Response(200, json={"data": self.token})
        if path.endswith("/messages"):
            if "status" in json.loads(request.content):
                return httpx.Response(200, json={"success": True})
            self._sent += 1
            return httpx.Response(
                200, json={"messages": [{"id": f"wamid.OUT{self._sent}"}]}
            )
        if path.endswith("/media"):
            return httpx.Response(200, json={"id": f"MEDIA-UP{len(self.requests)}"})
        if path.endswith(f"/{PHONE_ID}"):
            return httpx.Response(
                200,
                json={
                    "display_phone_number": "+1 555 000 0000",
                    "verified_name": "Acme",
                },
            )
        media_id = path.rsplit("/", 1)[-1]
        if media_id in self.media:
            mimetype, data = self.media[media_id]
            return httpx.Response(
                200,
                json={
                    "url": f"https://{self.media_host}/whatsapp_business/attachments/"
                    f"?mid={media_id}",
                    "mime_type": mimetype,
                    "id": media_id,
                    **({} if self.hide_sizes else {"file_size": len(data)}),
                },
            )
        return httpx.Response(
            404, json={"error": {"message": "Unknown path", "code": 100}}
        )

    def _posted(self) -> list[dict[str, Any]]:
        return [
            json.loads(r.content)
            for r in self.requests
            if r.url.path.endswith("/messages") and r.method == "POST"
        ]

    def sent(self) -> list[dict[str, Any]]:
        """The messages the adapter sent, in order."""
        return [body for body in self._posted() if "status" not in body]

    def receipts(self) -> list[dict[str, Any]]:
        """The read receipts and typing indicators the adapter sent."""
        return [body for body in self._posted() if "status" in body]


class Inbox:
    """What the adapter handed the bridge."""

    def __init__(self) -> None:
        self.messages: list[InboundMessage] = []
        self.commands: list[InboundCommand] = []
        self.interactions: list[InboundInteraction] = []

    async def message(self, message: InboundMessage) -> None:
        self.messages.append(message)

    async def command(self, command: InboundCommand) -> None:
        self.commands.append(command)

    async def interaction(self, interaction: InboundInteraction) -> None:
        self.interactions.append(interaction)

    async def ignore(self, _: object) -> None:
        return None


def install_fake_meta(monkeypatch: pytest.MonkeyPatch) -> FakeMeta:
    """Route every HTTP call the adapter makes to a fresh `FakeMeta`."""
    fake = FakeMeta()
    monkeypatch.setattr(
        adapter_module,
        "new_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    return fake


async def started(inbox: Inbox, *, new_chat_agents: str = "") -> WhatsAppAdapter:
    adapter = WhatsAppAdapter(
        config=WhatsAppConnectionConfig.model_validate(
            {**CONFIG, "new_chat_agents": new_chat_agents}
        )
    )
    adapter.set_webhook_url(WEBHOOK_URL)
    adapter.set_interaction_handler(inbox.interaction)
    await adapter.start(
        inbox.message, inbox.command, inbox.ignore, inbox.ignore, inbox.ignore
    )
    return adapter


def signed(payload: dict[str, Any], secret: str = SECRET) -> WebhookRequest:
    body = json.dumps(payload).encode()
    signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return WebhookRequest(
        method="POST",
        headers={"x-hub-signature-256": f"sha256={signature}"},
        query={},
        body=body,
    )


async def deliver(adapter: WhatsAppAdapter, payload: dict[str, Any]) -> None:
    """What the webhook route does with one delivery, verified first."""
    request = signed(payload)
    await adapter.verify_webhook(request)
    event = adapter.parse_webhook(request)
    await adapter.dispatch_event(
        envelope_type=event.envelope_type, payload=event.payload
    )


def delivery(
    *messages: dict[str, Any],
    statuses: list[dict[str, Any]] | None = None,
    phone_number_id: str = PHONE_ID,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "messaging_product": "whatsapp",
        "metadata": {
            "display_phone_number": BUSINESS_NUMBER,
            "phone_number_id": phone_number_id,
        },
    }
    if messages:
        value["contacts"] = [{"profile": {"name": "Ada Lovelace"}, "wa_id": CONTACT}]
        value["messages"] = list(messages)
    if statuses:
        value["statuses"] = statuses
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "333", "changes": [{"field": "messages", "value": value}]}],
    }


def text(body: str, wamid: str = "wamid.IN1", **extra: Any) -> dict[str, Any]:
    return {
        "from": CONTACT,
        "id": wamid,
        "timestamp": NOW,
        "type": "text",
        "text": {"body": body},
        **extra,
    }


def pressed(reply_id: str, title: str, card: str = "wamid.CARD") -> dict[str, Any]:
    return {
        "from": CONTACT,
        "id": "wamid.PRESS",
        "timestamp": NOW,
        "type": "interactive",
        "context": {"from": BUSINESS_NUMBER, "id": card},
        "interactive": {
            "type": "button_reply",
            "button_reply": {"id": reply_id, "title": title},
        },
    }


def media_message(kind: str, media_id: str, **fields: Any) -> dict[str, Any]:
    return {
        "from": CONTACT,
        "id": f"wamid.{media_id}",
        "timestamp": NOW,
        "type": kind,
        kind: {"id": media_id, **fields},
    }
