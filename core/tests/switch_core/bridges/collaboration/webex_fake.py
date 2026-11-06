"""A stand-in for the Webex REST API, at the HTTP transport.

The adapter's own methods are never mocked: it talks HTTP to this, and the
tests read back what it was asked.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import httpx

from switch_core.bridges.collaboration.webex.adapter import (
    WebexAdapter,
    WebexConnectionConfig,
)
from switch_core.bridges.collaboration.webex.client import WebexClient

BOT_ID = "bot-person-id"
BOT_EMAIL = "switch-test@webex.bot"
SECRET = "test-webhook-secret"
TOKEN = "test-bot-token"
ADDRESS = "https://switch.example/messaging/bridges/b-1/events"


class FakeWebex:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.me: dict[str, Any] = {
            "id": BOT_ID,
            "displayName": "Switch Test",
            "emails": [BOT_EMAIL],
            "type": "bot",
        }
        self.messages: dict[str, dict[str, Any]] = {}
        self.actions: dict[str, dict[str, Any]] = {}
        self.people: dict[str, dict[str, Any]] = {}
        self.rooms: dict[str, dict[str, Any]] = {}
        self.webhooks: list[dict[str, Any]] = []
        self.files: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.fail: dict[tuple[str, str], httpx.Response] = {}
        self.fail_next: dict[tuple[str, str], list[httpx.Response]] = {}
        self._sent = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def sent(self, method: str = "POST", path: str = "/v1/messages") -> list[Any]:
        return [body for m, p, body in self.calls if m == method and p == path]

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        body: Any = None
        content_type = request.headers.get("content-type", "")
        if content_type.startswith("application/json"):
            body = json.loads(request.content)
        elif content_type.startswith("multipart/"):
            body = request.content
        self.calls.append((method, path, body))
        queued = self.fail_next.get((method, path))
        if queued:
            return queued.pop(0)
        failure = self.fail.get((method, path))
        if failure is not None:
            return failure
        if path == "/v1/people/me":
            return httpx.Response(200, json=self.me)
        if path.startswith("/v1/people/"):
            person = self.people.get(path.removeprefix("/v1/people/"))
            return httpx.Response(200, json=person) if person else httpx.Response(404)
        if path.startswith("/v1/messages/") and method == "GET":
            found = self.messages.get(path.removeprefix("/v1/messages/"))
            return httpx.Response(200, json=found) if found else httpx.Response(404)
        if path == "/v1/messages" and method == "POST":
            if (
                isinstance(body, dict)
                and body.get("attachments")
                and "<@" in str(body.get("markdown", ""))
            ):
                return httpx.Response(
                    400,
                    json={
                        "message": "Mentions not allowed to be used with attachments."
                    },
                )
            self._sent += 1
            return httpx.Response(200, json={"id": f"sent-{self._sent}"})
        if path.startswith("/v1/messages/") and method == "PUT":
            return httpx.Response(200, json={})
        if path.startswith("/v1/messages/") and method == "DELETE":
            return httpx.Response(204)
        if path.startswith("/v1/attachment/actions/"):
            found = self.actions.get(path.removeprefix("/v1/attachment/actions/"))
            return httpx.Response(200, json=found) if found else httpx.Response(404)
        if path == "/v1/rooms" and method == "POST":
            return httpx.Response(200, json={"id": "new-room", "type": "group"})
        if path.startswith("/v1/rooms/"):
            room = self.rooms.get(path.removeprefix("/v1/rooms/"))
            return httpx.Response(200, json=room) if room else httpx.Response(404)
        if path == "/v1/memberships" and method == "POST":
            return httpx.Response(200, json={"id": "m-1"})
        if path == "/v1/webhooks" and method == "GET":
            return httpx.Response(200, json={"items": self.webhooks})
        if path == "/v1/webhooks" and method == "POST":
            hook = dict(body, id=f"hook-{len(self.webhooks) + 1}", status="active")
            self.webhooks.append(hook)
            return httpx.Response(200, json=hook)
        if path.startswith("/v1/webhooks/") and method == "DELETE":
            hook_id = path.removeprefix("/v1/webhooks/")
            self.webhooks = [h for h in self.webhooks if h["id"] != hook_id]
            return httpx.Response(204)
        if path.startswith("/v1/webhooks/") and method == "PUT":
            hook_id = path.removeprefix("/v1/webhooks/")
            for hook in self.webhooks:
                if hook["id"] == hook_id:
                    hook.update(body)
            return httpx.Response(200, json={})
        if path.startswith("/v1/contents/"):
            data, headers = self.files[path.removeprefix("/v1/contents/")]
            return httpx.Response(200, content=data, headers=headers)
        return httpx.Response(404, json={"message": f"no fake for {method} {path}"})


def adapter_for(fake: FakeWebex, *, listening: bool = True) -> WebexAdapter:
    adapter = WebexAdapter(
        config=WebexConnectionConfig(bot_token=TOKEN, webhook_secret=SECRET)
    )
    adapter.set_webhook_url(ADDRESS)
    adapter.set_listening(listening)
    adapter._connect = lambda token: WebexClient.connect(  # type: ignore[method-assign]
        token, transport=fake.transport()
    )
    return adapter


def envelope(resource: str, data_id: str, **data: Any) -> dict[str, Any]:
    """A delivery as Webex sends it: the envelope's `id` is the webhook's own."""
    return {
        "id": "the-webhook-id",
        "name": f"Switch {resource}",
        "resource": resource,
        "event": "created",
        "actorId": data.get("personId", "someone"),
        "data": {"id": data_id, **data},
    }


def spark_signature(body: bytes, secret: str = SECRET) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha1).hexdigest()
