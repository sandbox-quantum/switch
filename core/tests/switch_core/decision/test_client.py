"""The decision client against a stub decision service on a real socket: a
good answer, and every way of not getting one, each of which means nobody
answers."""

from __future__ import annotations

import asyncio
import json
import logging
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest

from switch_core.decision.client import (
    ContextMessage,
    DecisionAgent,
    DecisionAnswer,
    DecisionClient,
    DecisionMessage,
    DecisionRequest,
    DecisionRoom,
)

_GOOD = {
    "agent": "deploy",
    "model_choice": "deploy",
    "confidence": 0.91,
    "threshold": 0.6,
    "reason": "the question is about a deploy",
    "model": "clef-flash",
    "latency_ms": 312,
}


@dataclass
class _Stub:
    """A decision service on 127.0.0.1 that answers every request with
    `status` and `body`, after `delay` seconds, and records what it was
    sent."""

    status: int = 200
    body: bytes = json.dumps(_GOOD).encode()
    delay: float = 0.0
    received: list[tuple[dict[str, str], dict[str, Any]]] = field(default_factory=list)
    url: str = ""

    async def handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        headers = {
            name.strip().lower(): value.strip()
            for name, _, value in (line.partition(":") for line in lines[1:] if line)
        }
        body = await reader.readexactly(int(headers.get("content-length", "0")))
        self.received.append((headers, json.loads(body)))
        await asyncio.sleep(self.delay)
        reason = {200: "OK", 500: "Internal Server Error", 502: "Bad Gateway"}
        writer.write(
            f"HTTP/1.1 {self.status} {reason.get(self.status, 'Status')}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(self.body)}\r\n"
            "Connection: close\r\n\r\n".encode()
            + self.body
        )
        await writer.drain()
        writer.close()


@pytest.fixture
async def stub() -> AsyncIterator[_Stub]:
    service = _Stub()
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    service.url = f"http://127.0.0.1:{port}/decide"
    async with server:
        yield service
        server.close()


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient() as client:
        yield client


def _client(
    http: httpx.AsyncClient, url: str, *, api_key: str | None = None
) -> DecisionClient:
    return DecisionClient(
        endpoint_url=url, api_key=api_key, timeout_seconds=0.5, client=http
    )


def _request() -> DecisionRequest:
    return DecisionRequest(
        room=DecisionRoom(name="ops", instructions="Keep it short."),
        message=DecisionMessage(
            sender="alice",
            text="can someone check why last night's deploy failed?",
            thread_id=None,
        ),
        agents=[
            DecisionAgent(name="deploy", description="Runs deploys", role=None),
            DecisionAgent(name="billing", description="Invoices", role="finance"),
        ],
        thread=[],
        recent=[
            ContextMessage(
                sender="alice",
                sender_kind="person",
                text="@deploy is the pipeline green?",
                addressed=["deploy"],
            ),
            ContextMessage(
                sender="deploy", sender_kind="agent", text="Yes", addressed=[]
            ),
        ],
    )


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
        return port


async def test_a_good_answer(stub: _Stub, http: httpx.AsyncClient) -> None:
    answer = await _client(http, stub.url, api_key="placeholder").decide(
        _request(), room_id="room-1"
    )

    assert answer == DecisionAnswer(
        agent="deploy",
        model_choice="deploy",
        confidence=0.91,
        threshold=0.6,
        reason="the question is about a deploy",
        model="clef-flash",
        latency_ms=312.0,
    )
    [(headers, body)] = stub.received
    assert headers["authorization"] == "Bearer placeholder"
    assert body == _request().model_dump(mode="json")
    assert body["recent"][0] == {
        "sender": "alice",
        "sender_kind": "person",
        "text": "@deploy is the pipeline green?",
        "addressed": ["deploy"],
    }


async def test_no_key_sends_no_authorization(
    stub: _Stub, http: httpx.AsyncClient
) -> None:
    await _client(http, stub.url).decide(_request(), room_id="room-1")

    [(headers, _)] = stub.received
    assert "authorization" not in headers


async def test_nobody_is_an_answer(stub: _Stub, http: httpx.AsyncClient) -> None:
    stub.body = json.dumps(
        {**_GOOD, "agent": None, "model_choice": "billing", "confidence": 0.45}
    ).encode()

    answer = await _client(http, stub.url).decide(_request(), room_id="room-1")

    assert answer is not None
    assert answer.agent is None
    assert answer.model_choice == "billing"
    assert answer.confidence == 0.45


async def test_a_timeout_means_nobody(
    stub: _Stub, http: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    stub.delay = 2.0

    with caplog.at_level(logging.WARNING):
        answer = await _client(http, stub.url).decide(_request(), room_id="room-1")

    assert answer is None
    assert "did not answer within 0.5s" in caplog.text
    assert "room-1" in caplog.text


async def test_a_service_that_is_not_running_means_nobody(
    http: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    url = f"http://127.0.0.1:{_closed_port()}/decide"

    with caplog.at_level(logging.WARNING):
        answer = await _client(http, url).decide(_request(), room_id="room-1")

    assert answer is None
    assert "could not be reached" in caplog.text
    assert url in caplog.text


@pytest.mark.parametrize("status", [500, 502, 401, 201])
async def test_any_status_but_200_means_nobody(
    stub: _Stub,
    http: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
    status: int,
) -> None:
    stub.status = status
    stub.body = b'{"detail": "model server unreachable"}'

    with caplog.at_level(logging.WARNING):
        answer = await _client(http, stub.url).decide(_request(), room_id="room-1")

    assert answer is None
    assert f"answered {status}" in caplog.text
    assert "model server unreachable" in caplog.text


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        json.dumps({k: v for k, v in _GOOD.items() if k != "agent"}).encode(),
        json.dumps({**_GOOD, "agent": 7}).encode(),
        json.dumps({**_GOOD, "confidence": "high"}).encode(),
        json.dumps({**_GOOD, "threshold": None}).encode(),
    ],
)
async def test_a_malformed_body_means_nobody(
    stub: _Stub,
    http: httpx.AsyncClient,
    caplog: pytest.LogCaptureFixture,
    body: bytes,
) -> None:
    stub.body = body

    with caplog.at_level(logging.WARNING):
        answer = await _client(http, stub.url).decide(_request(), room_id="room-1")

    assert answer is None
    assert "answered something other than a decision" in caplog.text


async def test_a_name_that_was_not_a_candidate_means_nobody(
    stub: _Stub, http: httpx.AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    stub.body = json.dumps({**_GOOD, "agent": "docs"}).encode()

    with caplog.at_level(logging.WARNING):
        answer = await _client(http, stub.url).decide(_request(), room_id="room-1")

    assert answer is None
    [record] = [r for r in caplog.records if "not one of the candidates" in r.message]
    assert record.levelno == logging.ERROR
    assert "'docs'" in record.message
