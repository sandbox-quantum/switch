"""Smoke test for the benchmark harness itself.

No measurement is asserted here — only that the machinery the measurements
rest on works, without the Node side: the real agent-bridge app serves on a
real socket, an agent opens a stream and states where its session is, an
addressed message is delivered over the stream, and the session's reply and
turn row come back through the routes a session host uses. Every server-side
point fires and correlates to the same message.

The `reply_committed` assertion is the load-bearing one. It is recorded by a
SQLAlchemy engine listener that reads a context variable set by the ASGI
wrapper several layers up, through the greenlet SQLAlchemy uses to bridge sync
and async. If that propagation ever stops holding, every figure involving the
commit point silently loses its population, and this is where it is caught.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import httpx
import pytest

from tests.benchmarks.client import AgentConnection
from tests.benchmarks.server import BenchServer
from tests.benchmarks.trace import (
    REPLY_ACCEPTED,
    REPLY_COMMITTED,
    REPLY_RECEIVED,
    SSE_PUSH,
    TURN_REPORTED,
    TraceCollector,
    correlation_for,
    measure,
)

pytestmark = [pytest.mark.benchmark, pytest.mark.asyncio(loop_scope="session")]


async def test_harness_serves_and_instruments_one_message(
    bench: BenchServer, collector: TraceCollector
) -> None:
    target = await bench.register_agent("bench-target")
    poster = await bench.register_agent("bench-poster")
    await bench.start_clients(timeout=30.0)

    room_id = await bench.create_room(
        "bench-smoke-room", [target.agent_id, poster.agent_id]
    )
    connection_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())

    connection = AgentConnection(
        base_url=bench.base_url,
        api_key=target.api_key,
        agent_id=target.agent_id,
        connection_id=connection_id,
        scope="all",
        delivery_filter="addressed",
        spawn_capable=False,
    )
    await connection.open(timeout=15.0)
    async with httpx.AsyncClient(
        base_url=bench.base_url,
        headers={"Authorization": f"Bearer {target.api_key}"},
        timeout=30.0,
    ) as client:
        try:
            state = await connection.next_frame("connection_state", timeout=10.0)
            assert state.data["agent_id"] == target.agent_id

            placed = await client.post(
                f"/agents/{target.agent_id}/connection/placements",
                json={
                    "connection_id": connection_id,
                    "placements": {session_id: room_id},
                },
            )
            assert placed.status_code == 200, placed.text
            assert bench.placed_sessions(target.agent_id, [room_id]) == {
                room_id: session_id
            }

            posted = await bench.address(
                sender=poster,
                room_id=room_id,
                target=target.name,
                body=f"@{target.name} baseline benchmark harness check",
            )

            frame = await connection.next_frame("message", timeout=20.0)
            message_id = frame.data["payload"]["message_id"]
            correlation = correlation_for(frame.data["room_id"], message_id)
            # The driver has no stream of its own — the real watcher holds it —
            # so it names the message it posted from what `address` returned.
            assert posted == message_id
            # The watcher routes by its own map; Switch no longer says which
            # session an event is for.
            assert "session_id" not in frame.data

            turn = await client.post(
                f"/agent-sessions/{session_id}/activity",
                json={
                    "turn_id": "turn-1",
                    "item_id": "turn",
                    "kind": "turn",
                    "revision": 1,
                    "status": "completed",
                    "title": "Answered",
                    "text": "",
                    "command_id": None,
                    "room_id": room_id,
                    "thread_id": message_id,
                    "message_id": message_id,
                    "occurred_at": datetime.now(UTC).isoformat(),
                },
            )
            assert turn.status_code == 200, turn.text

            reply = await client.post(
                f"/agents/{target.agent_id}/ops/post_message",
                json={
                    "body": f"switch-bench-reply:smoke room={room_id} "
                    f"message={message_id}"
                },
                headers={
                    "X-Switch-Connection-Id": connection_id,
                    "X-Switch-Session-Id": session_id,
                },
            )
            assert reply.status_code == 200, reply.text
        finally:
            await connection.close()

    # Posted where Switch has the session placed, which is the room.
    assert (await bench.replies())[correlation] == [room_id]
    rows = await bench.activity_rows(target.agent_id)
    assert [(row.session_id, row.kind, row.message_id) for row in rows] == [
        (session_id, "turn", message_id)
    ]

    points = collector.by_correlation()
    assert correlation in points, (
        f"nothing was traced for {correlation}; traced: {sorted(points)}"
    )
    recorded = points[correlation]
    for point in (
        SSE_PUSH,
        TURN_REPORTED,
        REPLY_RECEIVED,
        REPLY_COMMITTED,
        REPLY_ACCEPTED,
    ):
        assert point in recorded, (
            f"{point} was never recorded for {correlation}; got {sorted(recorded)}"
        )

    report, missing = measure(
        collector,
        start_point=SSE_PUSH,
        end_point=REPLY_RECEIVED,
        name="sse push → reply received",
    )
    assert missing == []
    assert report.samples == 1
    assert not report.cross_process
    assert report.p50 >= 0
