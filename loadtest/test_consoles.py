"""Console windows' re-reads, against a fake gateway. No server."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from agents import Stats  # noqa: E402
from consoles import BATCH, Console, membership_reads, tracked_agents  # noqa: E402
from seed import RequestIds  # noqa: E402


def test_per_agent_reads_each_agent_and_batch_a_hundred_at_a_time():
    agents = [f"a{i}" for i in range(BATCH + 1)]
    per_agent = membership_reads("per-agent", agents)
    assert [path for path, _ in per_agent] == [
        f"/agents/a{i}" for i in range(BATCH + 1)
    ]
    batch = membership_reads("batch", agents)
    assert [path for path, _ in batch] == ["/agents/rooms", "/agents/rooms"]
    assert [len(query) for _, query in batch] == [BATCH, 1]
    assert batch[1][1] == [("agent_id", f"a{BATCH}")]


def test_windows_track_the_next_agents_and_start_over_when_short():
    agents = ["a", "b", "c", "d", "e"]
    assert tracked_agents(agents, 2, 2) == [["a", "b"], ["c", "d"]]
    assert tracked_agents(agents, 3, 2)[2] == ["e", "a"]
    assert tracked_agents(agents, 1, 9) == [agents]
    assert tracked_agents([], 2, 3) == [[], []]


def _console(handler, mode: str, agents: list[str], interval: float = 20.0):
    stats = Stats(phase="idle@60")
    console = Console(
        0, "http://gw", "cookie", agents, mode, interval, RequestIds("t"), stats, 1
    )
    console.http = httpx.AsyncClient(
        base_url="http://gw", transport=httpx.MockTransport(handler)
    )
    return console, stats


def test_a_re_read_asks_for_the_rooms_and_each_agent_and_counts_failures():
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        assert request.headers["cookie"] == "switch_auth=cookie"
        status = 500 if request.url.path == "/gateway/agents/a2" else 200
        return httpx.Response(status, json=[])

    console, stats = _console(handler, "per-agent", ["a1", "a2", "a3"])
    asyncio.run(console.refresh())

    assert sorted(seen) == [
        "/gateway/agents/a1",
        "/gateway/agents/a2",
        "/gateway/agents/a3",
        "/gateway/rooms",
    ]
    assert len(stats.console_refreshes["idle@60"]) == 1
    assert stats.console_requests["idle@60"] == 4
    assert stats.console_errors["idle@60"] == 1
    assert [e["kind"] for e in stats.events] == ["console_refused"]
    assert len(stats.console_reads[("idle@60", "rooms")]) == 1
    assert len(stats.console_reads[("idle@60", "agents")]) == 3


def test_batch_on_a_server_without_the_route_is_an_error_not_a_fallback():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/gateway/agents/rooms":
            return httpx.Response(404, json={"detail": "Agent not found: rooms"})
        return httpx.Response(200, json=[])

    console, stats = _console(handler, "batch", ["a1", "a2"])
    asyncio.run(console.refresh())

    assert stats.console_requests["idle@60"] == 2
    assert stats.console_errors["idle@60"] == 1


def test_the_next_re_read_starts_on_time_while_the_last_is_still_waiting():
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.2)
        return httpx.Response(200, json=[])

    async def scenario() -> Stats:
        console, stats = _console(handler, "per-agent", ["a1"], interval=0.05)
        stop = asyncio.Event()
        task = asyncio.create_task(console.run(stop))
        await asyncio.sleep(0.6)
        stop.set()
        await task
        await console.stop()
        return stats

    stats = asyncio.run(scenario())
    # Each re-read takes 0.2 s, four times the interval: re-reads that waited
    # for the last one would have finished one or two.
    assert len(stats.console_refreshes["idle@60"]) >= 4
    assert min(stats.console_refreshes["idle@60"]) >= 0.2
