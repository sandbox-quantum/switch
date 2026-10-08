"""The signed-in user's change socket: hello, notices, pings, refusal, expiry.

Authentication is `get_current_user`'s own checks (`authenticate_socket`),
covered with the gateway's auth tests; here it is replaced, so these tests
are about the socket.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from switch_core.gateway import changes
from switch_core.gateway import dependencies as gw_deps
from switch_core.gateway.auth import SocketCaller
from switch_core.user_changes import MACHINE, MANAGED_AGENT, LocalUserChanges


def _app(feed: LocalUserChanges) -> FastAPI:
    app = FastAPI()
    app.include_router(changes.router)
    app.dependency_overrides[gw_deps.get_session_factory] = lambda: None
    app.dependency_overrides[gw_deps.get_user_store] = lambda: None
    app.dependency_overrides[gw_deps.get_config] = lambda: SimpleNamespace()
    app.dependency_overrides[gw_deps.get_user_changes] = lambda: feed

    # Notices are published on the app's own loop, as a committed change is.
    @app.post("/publish/{user_id}/{kind}/{id}")
    async def publish(user_id: str, kind: str, id: str) -> None:
        feed.publish("t1", user_id, kind, id)

    return app


@pytest.fixture
def feed() -> LocalUserChanges:
    return LocalUserChanges()


def _signed_in(
    monkeypatch: pytest.MonkeyPatch, user_id: str = "ada", expires_in: float = 3600
) -> None:
    async def _authenticate(*_: Any) -> SocketCaller:
        return SocketCaller(
            user_id=user_id, tenant_id="t1", expires_at=time.time() + expires_in
        )

    monkeypatch.setattr(changes, "authenticate_socket", _authenticate)


@pytest.fixture
def client(feed: LocalUserChanges) -> Iterator[TestClient]:
    with TestClient(_app(feed)) as client:
        yield client


def test_opens_with_hello_naming_the_kinds_it_sends(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        hello = ws.receive_json()
    assert hello["event"] == "hello"
    assert set(hello["data"]["kinds"]) == {MANAGED_AGENT, MACHINE}
    assert hello["data"]["ping_interval_s"] == changes.PING_INTERVAL_SECONDS


def test_a_change_to_the_user_arrives_as_a_notice(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        client.post(f"/publish/ada/{MANAGED_AGENT}/a1")
        frame = ws.receive_json()
    assert frame == {
        "event": "changed",
        "data": {"changes": [{"kind": MANAGED_AGENT, "id": "a1"}]},
    }


def test_another_users_change_is_not_sent(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(changes, "PING_INTERVAL_SECONDS", 0.05)
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        client.post(f"/publish/bob/{MANAGED_AGENT}/a1")
        # The next frame is a ping, not bob's notice.
        assert ws.receive_json()["event"] == "ping"


def test_pings_and_closes_a_client_that_never_answers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(changes, "PING_INTERVAL_SECONDS", 0.02)
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        events = []
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                events.append(ws.receive_json()["event"])
    assert "ping" in events
    assert closed.value.code == 1001


def test_a_client_that_answers_pings_stays(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(changes, "PING_INTERVAL_SECONDS", 0.02)
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        for _ in range(8):
            assert ws.receive_json()["event"] == "ping"
            ws.send_json({"type": "pong"})


def test_a_refused_socket_says_why_and_closes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _refuse(*_: Any) -> SocketCaller:
        raise HTTPException(status_code=401, detail="Not authenticated")

    monkeypatch.setattr(changes, "authenticate_socket", _refuse)
    with client.websocket_connect("/changes/ws") as ws:
        refused = ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert refused == {
        "event": "refused",
        "data": {"status": 401, "detail": "Not authenticated"},
    }
    assert closed.value.code == 4401


def test_closes_with_4401_when_the_session_cookie_expires(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _signed_in(monkeypatch, expires_in=0.05)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401


def test_closing_the_socket_drops_its_subscription(
    client: TestClient, feed: LocalUserChanges, monkeypatch: pytest.MonkeyPatch
) -> None:
    _signed_in(monkeypatch)
    with client.websocket_connect("/changes/ws") as ws:
        ws.receive_json()
        assert feed.subscriber_count("t1", "ada") == 1
    for _ in range(100):
        if feed.subscriber_count("t1", "ada") == 0:
            break
        time.sleep(0.01)
    assert feed.subscriber_count("t1", "ada") == 0


def test_a_user_past_the_socket_cap_is_refused_with_429(
    client: TestClient, feed: LocalUserChanges, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client opening sockets in a loop stops at the cap; the user's open
    sockets are untouched, and another user is not affected."""
    _signed_in(monkeypatch)
    for _ in range(changes.MAX_SOCKETS_PER_USER):
        feed.subscribe("t1", "ada")
    with client.websocket_connect("/changes/ws") as ws:
        refused = ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert refused["event"] == "refused"
    assert refused["data"]["status"] == 429
    assert closed.value.code == 4429
    assert feed.subscriber_count("t1", "ada") == changes.MAX_SOCKETS_PER_USER

    _signed_in(monkeypatch, user_id="grace")
    with client.websocket_connect("/changes/ws") as ws:
        assert ws.receive_json()["event"] == "hello"
