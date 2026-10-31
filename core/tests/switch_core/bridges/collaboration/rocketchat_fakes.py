"""A Rocket.Chat server faked at the HTTP transport, for the adapter's tests.

The adapter's own `httpx` client is kept and only its transport is replaced,
so requests are built, sent and read exactly as against a real server. Each
REST method answers from a handler a test can replace, and every request is
recorded for the test to inspect.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
import pytest

from switch_core.bridges.collaboration.rocketchat import adapter as adapter_module
from switch_core.bridges.collaboration.rocketchat.adapter import (
    RocketChatAdapter,
    RocketChatConnectionConfig,
)
from switch_core.outbound import OutboundPolicy

SERVER = "https://chat.example.com"
BOT_ID = "bot-user-id"
BOT_USERNAME = "switchbot"
ROOM = "room-1"

# Held before any test replaces `httpx.AsyncClient` to reach `verify_credentials`.
_AsyncClient = httpx.AsyncClient

Handler = Callable[["Call"], httpx.Response | dict[str, Any]]


@dataclass
class Call:
    method: str
    path: str
    # As sent, before percent-decoding.
    raw_path: str
    params: dict[str, str]
    body: Any
    headers: httpx.Headers

    @property
    def name(self) -> str:
        """The REST method, `chat.postMessage` for `/api/v1/chat.postMessage`."""
        return self.path.removeprefix("/api/v1/")


def refused(status: int, error: str, error_type: str | None = None) -> httpx.Response:
    body: dict[str, Any] = {"success": False, "error": error}
    if error_type is not None:
        body["errorType"] = error_type
    return httpx.Response(status, json=body)


class FakeRocketChat:
    def __init__(self) -> None:
        self.calls: list[Call] = []
        self.files: dict[str, bytes] = {}
        self._posted = 0
        self.handlers: dict[str, Handler] = {
            "me": lambda _: {
                "_id": BOT_ID,
                "username": BOT_USERNAME,
                "roles": ["bot"],
                "active": True,
            },
            "chat.postMessage": self._post_message,
            "subscriptions.read": lambda _: {},
            "subscriptions.get": lambda _: {"update": [], "remove": []},
        }

    def on(self, name: str, handler: Handler) -> None:
        self.handlers[name] = handler

    def called(self, name: str) -> list[Call]:
        return [call for call in self.calls if call.name == name]

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def client(self, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("verify", None)
        return _AsyncClient(transport=self.transport(), **kwargs)

    def _post_message(self, call: Call) -> dict[str, Any]:
        self._posted += 1
        return {"message": {"_id": f"posted-{self._posted}", **call.body}}

    def _handle(self, request: httpx.Request) -> httpx.Response:
        content_type = request.headers.get("content-type", "")
        body: Any = None
        if content_type.startswith("application/json"):
            body = json.loads(request.content)
        elif content_type.startswith("multipart/form-data"):
            body = request.content
        call = Call(
            method=request.method,
            path=request.url.path,
            raw_path=request.url.raw_path.decode(),
            params=dict(request.url.params),
            body=body,
            headers=request.headers,
        )
        self.calls.append(call)
        if request.url.path.startswith("/file-upload/"):
            data = self.files.get(request.url.path)
            if data is None:
                return refused(404, "File not found")
            return httpx.Response(200, content=data)
        handler = self.handlers.get(call.name) or self.handlers.get(
            call.name.split("/", 1)[0]
        )
        if handler is None:
            return refused(404, "Resource not found")
        answer = handler(call)
        if isinstance(answer, httpx.Response):
            return answer
        return httpx.Response(200, json={**answer, "success": True})


def config(**overrides: Any) -> RocketChatConnectionConfig:
    return RocketChatConnectionConfig.model_validate(
        {
            "server_url": SERVER,
            "bot_user_id": BOT_ID,
            "personal_access_token": "test-placeholder-token",
            **overrides,
        }
    )


async def started_adapter(
    fake: FakeRocketChat,
    monkeypatch: pytest.MonkeyPatch,
    *,
    listening: bool = False,
) -> RocketChatAdapter:
    """A started adapter talking to `fake`. Quiet unless asked to listen, so a
    test of the REST side opens no socket."""

    def client(policy: OutboundPolicy, **kwargs: Any) -> httpx.AsyncClient:
        return fake.client(**kwargs)

    monkeypatch.setattr(adapter_module, "guarded_async_client", client)
    adapter = RocketChatAdapter(config=config())
    # Loopback, where the tests' realtime server listens.
    adapter.set_outbound_policy(OutboundPolicy.parse("127.0.0.0/8"))
    adapter.set_listening(listening)
    await adapter.start(_ignore, _ignore, _ignore, _ignore, _ignore)
    return adapter


async def _ignore(_: object) -> None:
    return None
