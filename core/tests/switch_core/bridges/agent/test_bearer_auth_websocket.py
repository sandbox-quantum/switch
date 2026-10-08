"""BearerAuthMiddleware refusing a WebSocket.

A WebSocket client cannot read the status of a refused handshake, so the
refusal is a close code it can read: 4000 plus the status, 4401 for a missing
or bad token.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from switch_core.bridges.agent.api_key_cache import ApiKeyCache
from switch_core.bridges.agent.auth import BearerAuthMiddleware, ControllerPrincipal
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.api_key_store import ApiKeyStore


def _middleware() -> tuple[BearerAuthMiddleware, list[Any]]:
    reached: list[Any] = []

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        reached.append(scope)

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=None,  # type: ignore[arg-type]
    )
    return mw, reached


async def _call(mw: BearerAuthMiddleware, scope: dict[str, Any]) -> list[dict]:
    sent: list[dict] = []
    inbox = [{"type": "websocket.connect"}]

    async def receive() -> dict:
        return inbox.pop(0)

    async def send(message: dict) -> None:
        sent.append(message)

    await mw(scope, receive, send)
    return sent


async def test_a_socket_without_a_token_is_accepted_and_closed_with_4401() -> None:
    mw, reached = _middleware()

    sent = await _call(
        mw,
        {
            "type": "websocket",
            "path": "/agents/a1/connection/ws",
            "headers": [],
            "query_string": b"",
        },
    )

    assert [m["type"] for m in sent] == ["websocket.accept", "websocket.close"]
    assert sent[1]["code"] == 4401
    assert reached == []


async def test_a_request_without_a_token_is_still_an_http_401() -> None:
    mw, reached = _middleware()
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    await mw(
        {
            "type": "http",
            "method": "GET",
            "path": "/agents/a1/events",
            "headers": [],
            "query_string": b"",
        },
        receive,
        send,
    )

    assert sent[0]["status"] == 401
    assert reached == []


class _NotAssigned:
    """A controller whose token is good and which runs no agent at all."""

    presence = SimpleNamespace(binding=lambda agent_id: None)
    auth_cache = None

    def handles(self, path: str) -> bool:
        return False

    def is_public(self, path: str) -> bool:
        return False

    def is_controller_token(self, token: str) -> bool:
        return True

    async def authenticate(self, token: str) -> ControllerPrincipal:
        return ControllerPrincipal(controller_id="c1", owner_id="u1", tenant_id="t1")


async def test_a_controller_refused_on_the_socket_is_told_why_in_a_close() -> None:
    reached: list[Any] = []

    async def _app(scope: Any, receive: Any, send: Any) -> None:
        reached.append(scope)

    mw = BearerAuthMiddleware(
        _app,
        agent_store=AgentStore(),
        api_key_store=ApiKeyStore(),
        api_key_cache=ApiKeyCache(ttl_seconds=5, max_entries=8),
        session_factory=None,  # type: ignore[arg-type]
        controller_auth=_NotAssigned(),  # type: ignore[arg-type]
    )

    sent = await _call(
        mw,
        {
            "type": "websocket",
            "path": "/agents/a1/connection/ws",
            "headers": [(b"authorization", b"Bearer controller-token")],
            "query_string": b"",
        },
    )

    assert [m["type"] for m in sent] == [
        "websocket.accept",
        "websocket.send",
        "websocket.close",
    ]
    frame = json.loads(sent[1]["text"])
    assert frame["event"] == "refused"
    assert frame["data"]["status"] == 403
    assert frame["data"]["detail"]["code"] == "not_assigned"
    assert sent[2]["code"] == 4403
    assert reached == []
