from __future__ import annotations

import asyncio
from typing import Any

from switch_core.bridges.collaboration.teams.auth import (
    BOT_CONNECTOR_SCOPE,
    TeamsTokenProvider,
)


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeResp:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeHttp:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, data: dict[str, Any]) -> _FakeResp:
        self.calls.append({"url": url, "data": data})
        return self._resp


def _provider(http: _FakeHttp) -> TeamsTokenProvider:
    return TeamsTokenProvider(
        tenant_id="tenant-1",
        app_id="app-1",
        app_password="secret",
        http=http,  # type: ignore[arg-type]
    )


def test_token_is_fetched_and_returned() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    token = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert token == "tok-1"
    assert len(http.calls) == 1
    assert http.calls[0]["data"]["scope"] == BOT_CONNECTOR_SCOPE
    assert http.calls[0]["data"]["grant_type"] == "client_credentials"


def test_token_is_cached_until_expiry() -> None:
    http = _FakeHttp(_FakeResp(200, {"access_token": "tok-1", "expires_in": 3600}))
    provider = _provider(http)

    first = _run(provider.token(BOT_CONNECTOR_SCOPE))
    second = _run(provider.token(BOT_CONNECTOR_SCOPE))

    assert first == second == "tok-1"
    # Only one network round-trip — the second call is served from cache.
    assert len(http.calls) == 1


def test_token_error_raises() -> None:
    http = _FakeHttp(_FakeResp(401, {"error": "invalid_client"}))
    provider = _provider(http)

    try:
        _run(provider.token(BOT_CONNECTOR_SCOPE))
        raised = False
    except RuntimeError:
        raised = True
    assert raised
