"""Smoke test for the benchmark harness itself.

No measurement is asserted here — only that the machinery the measurements will
rest on actually works: the real agent-bridge app serves on a real socket, an
agent authenticates and opens a stream, an addressed message is delivered over
it, the host's admission is accepted, and all four server-side instrumentation
points fire and correlate to the same message.

The `core_commit` assertion is the load-bearing one. It is recorded by a
SQLAlchemy engine listener that reads a context variable set by the ASGI
wrapper several layers up, through the greenlet SQLAlchemy uses to bridge sync
and async. If that propagation ever stops holding, every latency figure
involving the commit point silently loses its population, and this is where it
is caught.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from tests.benchmarks.client import AgentConnection
from tests.benchmarks.server import BenchServer
from tests.benchmarks.trace import (
    ADMISSION_RECEIVED,
    ADMISSION_RESPONDED,
    CORE_COMMIT,
    SSE_PUSH,
    TraceCollector,
    correlation_for,
    measure,
)

pytestmark = [pytest.mark.benchmark, pytest.mark.asyncio(loop_scope="session")]

CAPABILITIES = {
    "input": "queue",
    "approvals": False,
    "questions": False,
    "interrupt": False,
    "reset": False,
    "compact": False,
    "modelChange": False,
    "attachmentMimeTypes": [],
}


async def test_harness_serves_and_instruments_one_message(
    bench: BenchServer, collector: TraceCollector
) -> None:
    target = await bench.register_agent("bench-target")
    poster = await bench.register_agent("bench-poster")
    await bench.start_clients(timeout=30.0)

    room_id = await bench.create_room(
        "bench-smoke-room", [target.agent_id, poster.agent_id]
    )

    connection = AgentConnection(
        base_url=bench.base_url,
        api_key=target.api_key,
        agent_id=target.agent_id,
        connection_id=str(uuid.uuid4()),
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
    )
    await connection.open(timeout=15.0)
    try:
        state = await connection.next_frame("connection_state", timeout=10.0)
        assert state.data["agent_id"] == target.agent_id

        session_id = str(uuid.uuid4())
        host_id = str(uuid.uuid4())
        # The epoch the host proposes is not the epoch it gets: `acquire` mints
        # a fresh one and every later call is fenced against that, not against
        # what was sent.
        epoch = await _acquire(
            bench, target.api_key, session_id, target.agent_id, host_id, room_id
        )

        posted = await bench.address(
            sender=poster,
            room_id=room_id,
            target=target.name,
            body=f"@{target.name} baseline benchmark harness check",
        )

        frame = await connection.next_frame("message", timeout=20.0)
        message_id = frame.data["payload"]["message_id"]
        correlation = correlation_for(frame.data["room_id"], message_id)
        assert frame.sequence is not None
        # The workload driver has no stream of its own — the real watcher holds
        # it — so it must name the message it posted from what `address`
        # returned. Everything it measures is keyed on the two being the same id.
        assert posted == message_id

        receipt = await _admit(
            bench,
            target.api_key,
            session_id,
            host_id,
            epoch,
            room_id,
            message_id,
            frame.sequence,
        )
        assert receipt["status"] in ("delivered", "queued", "accepted"), receipt
    finally:
        await connection.close()

    points = collector.by_correlation()
    assert correlation in points, (
        f"nothing was traced for {correlation}; traced: {sorted(points)}"
    )
    recorded = points[correlation]
    for point in (SSE_PUSH, ADMISSION_RECEIVED, CORE_COMMIT, ADMISSION_RESPONDED):
        assert point in recorded, (
            f"{point} was never recorded for {correlation}; got {sorted(recorded)}"
        )

    report, missing = measure(
        collector,
        start_point=SSE_PUSH,
        end_point=ADMISSION_RECEIVED,
        name="sse push → admission received",
    )
    assert missing == []
    assert report.samples == 1
    assert not report.cross_process
    assert report.p50 >= 0


async def _acquire(
    bench: BenchServer,
    api_key: str,
    session_id: str,
    agent_id: str,
    host_id: str,
    room_id: str,
) -> str:
    async with httpx.AsyncClient(
        base_url=bench.base_url, headers={"Authorization": f"Bearer {api_key}"}
    ) as client:
        response = await client.post(
            "/sessions/acquire",
            json={
                "sessionId": session_id,
                "agentId": agent_id,
                "provider": "claude",
                "hostId": host_id,
                "epoch": str(uuid.uuid4()),
                "status": "ready",
                "connectivity": "online",
                "capabilities": CAPABILITIES,
                "pendingRequestIds": [],
                "roomIds": [room_id],
            },
        )
    assert response.status_code == 200, response.text
    return str(response.json()["session"]["epoch"])


async def _admit(
    bench: BenchServer,
    api_key: str,
    session_id: str,
    host_id: str,
    epoch: str,
    room_id: str,
    message_id: str,
    sequence: int,
) -> dict:
    async with httpx.AsyncClient(
        base_url=bench.base_url, headers={"Authorization": f"Bearer {api_key}"}
    ) as client:
        response = await client.post(
            f"/sessions/{session_id}/room-message",
            json={
                "host_id": host_id,
                "epoch": epoch,
                "room_id": room_id,
                "message_id": message_id,
                "sequence": sequence,
                "missed_count": 0,
                "gap_reason": None,
            },
        )
    assert response.status_code == 200, response.text
    return response.json()
