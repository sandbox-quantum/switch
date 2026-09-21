"""The baseline measurement for the per-agent-connection work.

These are not pass/fail tests in the usual sense. Nothing here asserts a
threshold, because there is no agreed one to assert: the deliverable is a set
of figures for the topology as it stands today, so that the same harness run
against the changed topology has something to be compared with. What *is*
asserted is that the run happened — every span has both its ends, and every
message arrived exactly once wherever the topology is capable of delivering it
— because a benchmark that quietly measured half its workload, or measured the
first of two executions of the same work, would report a flattering number
rather than a failure. Where the topology is *not* capable, the messages
it drops are counted and printed rather than asserted away: today one agent is
refused more than `MAX_CONNECTIONS_PER_AGENT` inbound connections, so a session
count above that is a ceiling the baseline exists to record.

The headline figure is the peak number of agent protocol connections one agent
holds. Today that is N session streams plus the watcher's, so it is expected to
track the session count here. That is the thing being changed, and this is the
before.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from switch_core.bridges.agent.protocol.connections import MAX_CONNECTIONS_PER_AGENT
from tests.benchmarks.host import bench_watcher, build_bench_bundle, marked, new_marker
from tests.benchmarks.server import BenchServer
from tests.benchmarks.trace import TraceCollector, correlation_for
from tests.benchmarks.workload import (
    STREAM_TIMEOUT_SECONDS,
    Posted,
    WorkloadResult,
    await_stream,
    dispatch_timeout,
    dispatch_wait,
    publish,
    run_workload,
    sampler_for,
    score,
)

pytestmark = [pytest.mark.benchmark, pytest.mark.asyncio(loop_scope="session")]

#: Session counts to measure. One is the floor the topology cannot go below;
#: fifty is past the point where a per-session connection is the dominant cost.
SCALES = (1, 10, 50)

#: Messages per room. More than one so a session's *second* message — served by
#: an already-running host rather than a cold start — is in the population.
MESSAGES_PER_ROOM = 3


@pytest.fixture(scope="session")
def bundle() -> Path:
    return build_bench_bundle()


async def _measure(
    *,
    bench: BenchServer,
    collector: TraceCollector,
    bundle: Path,
    home: Path,
    slug: str,
    label: str,
    rooms: int,
    per_room: int,
    concurrent: bool,
) -> WorkloadResult:
    """Stand up one agent with its own watcher, measure it, and tear it down.

    `slug` names the agents and rooms and must satisfy Switch's own name rules;
    `label` is the prose the report is headed with. Kept as two arguments rather
    than one derived from the other, so a readable heading cannot quietly
    become an unreadable agent name.
    """
    target = await bench.register_agent(f"bench-target-{slug}")
    poster = await bench.register_agent(f"bench-poster-{slug}")
    await bench.start_clients(timeout=60.0)
    room_ids = [
        await bench.create_room(
            f"bench-{slug}-{index}", [target.agent_id, poster.agent_id]
        )
        for index in range(rooms)
    ]
    home.mkdir(parents=True)
    with bench_watcher(
        bundle=bundle,
        home=home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
    ) as watcher:
        return await run_workload(
            bench=bench,
            watcher=watcher,
            collector=collector,
            poster=poster,
            target=target,
            room_ids=room_ids,
            per_room=per_room,
            concurrent=concurrent,
            label=label,
        )


async def test_baseline_scales_with_session_count(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Connections, processes, memory and latency at 1, 10 and 50 sessions."""
    results: list[WorkloadResult] = []
    # Published after every scale rather than once at the end: the largest scale
    # is the one most likely to fail, and a failure there should not also throw
    # away the smaller scales that had already been measured.
    for rooms in SCALES:
        results.append(
            await _measure(
                bench=bench,
                collector=collector,
                bundle=bundle,
                home=tmp_path / f"home-{rooms}",
                slug=f"seq-{rooms}",
                label=f"{rooms} session(s), sequential",
                rooms=rooms,
                per_room=MESSAGES_PER_ROOM,
                concurrent=False,
            )
        )
        print("\n" + publish(results, tmp_path / "baseline-scaling.md"))

    for result in results:
        assert result.unmeasured == (), result.unmeasured
        assert result.messages == result.rooms * MESSAGES_PER_ROOM
        # One agent protocol stream per session plus the watcher's, capped by
        # what the server will admit. Asserted on the registry count rather
        # than the socket count because that is the thing the topology change
        # is about; the socket count is reported beside it but also carries
        # pooled HTTP traffic. A floor rather than an equality: a session whose
        # host has already exited has given its stream back, so the peak is
        # what has to hold.
        wanted = result.rooms + 1
        assert result.resources.peak_streams >= min(wanted, MAX_CONNECTIONS_PER_AGENT)
        # Below the cap every message must arrive exactly once. A loss there is
        # a defect rather than a measurement, and so is a repeat: a message
        # dispatched twice had its work done twice. At or above the cap the
        # loss is the ceiling itself and is reported rather than asserted away,
        # and a repeat is left unasserted with it — hosts refused a connection
        # retry for the rest of the run, so a redelivery there would be a
        # finding to investigate rather than a gate this run can hold.
        if wanted <= MAX_CONNECTIONS_PER_AGENT:
            assert result.undelivered == (), result.undelivered
            assert result.duplicated == (), result.duplicated


async def test_baseline_concurrent_delivery(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Every room addressed at once, rather than one after another."""
    result = await _measure(
        bench=bench,
        collector=collector,
        bundle=bundle,
        home=tmp_path / "home-concurrent",
        slug="concurrent",
        label="10 sessions, concurrent",
        rooms=10,
        per_room=MESSAGES_PER_ROOM,
        concurrent=True,
    )
    print("\n" + publish([result], tmp_path / "baseline-concurrent.md"))
    assert result.unmeasured == ()
    # Ten sessions plus the watcher is well inside what the server admits, so
    # arriving together must neither cost a message nor serve one twice. The
    # second is the likelier failure of the two here: messages arriving
    # together is the case where two hosts can race for the same room.
    assert result.undelivered == (), result.undelivered
    assert result.duplicated == (), result.duplicated


async def test_baseline_recovers_from_a_lost_host(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session host is killed outright; a replacement must take the room over.

    Measured because recovery is where a connection model is most likely to
    leak: the killed host's inbound stream has to be reaped and the replacement
    has to get one, and a topology that ends up holding both would show here as
    a connection count that never comes back down.

    The reap is waited for rather than assumed. Until the server releases the
    dead host's claim on the room it still considers the room served, so a
    message addressed in that window is routed to the process that is gone —
    which makes the window itself the figure worth reporting, and makes a test
    that posted immediately measure the window instead of the recovery.
    """
    target = await bench.register_agent("bench-target-recovery")
    poster = await bench.register_agent("bench-poster-recovery")
    await bench.start_clients(timeout=60.0)
    room_id = await bench.create_room(
        "bench-recovery", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-recovery"
    home.mkdir(parents=True)

    async def send(marker: str) -> str:
        return correlation_for(
            room_id,
            await bench.address(
                sender=poster,
                room_id=room_id,
                target=target.name,
                body=f"@{target.name} {marked(marker)}",
            ),
        )

    with bench_watcher(
        bundle=bundle,
        home=home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, host killed mid-run"):
            before = new_marker()
            markers = {before: await send(before)}
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))

            assigned = watcher.sessions_by_room()
            assert room_id in assigned, assigned
            assert bench.connections.has_session_in(target.agent_id, room_id)
            killed = watcher.kill_session(assigned[room_id])
            assert killed > 0

            reaped = await _await_spawnable(bench, target.agent_id, room_id, 60.0)

            after = new_marker()
            markers[after] = await send(after)
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))

        # Once, after both phases: the file is append-only and read whole, so
        # ingesting per phase would count the first phase's records twice.
        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, host killed mid-run",
        rooms=1,
        collector=collector,
        # Both messages are cold starts: the first spawns the session, and the
        # second spawns its replacement because the first host no longer exists.
        posted=Posted(markers=markers, cold=frozenset(markers.values())),
        undelivered=frozenset(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-recovery.md"))
    print(
        f"recovery: {killed} process(es) serving the session were killed outright; "
        f"the server released the room {reaped:.1f}s later and a replacement host "
        "was dispatched the next message"
    )
    assert result.unmeasured == ()
    # The case likeliest to execute a message twice, and the reason the figure
    # is collected at all: the host is killed at a point where it may already
    # have dispatched, and a replacement then takes the room over. Recovering
    # by redoing work that was already done is not recovery.
    assert result.duplicated == (), result.duplicated


async def _await_spawnable(
    bench: BenchServer, agent_id: str, room_id: str, timeout: float
) -> float:
    """Seconds until the server will let a new host take the room over.

    Polls the real connection registry rather than sleeping for the heartbeat
    TTL: the figure wanted is how long the topology actually holds a dead
    host's claim, and a fixed sleep would report the constant it was given.
    """
    started = asyncio.get_running_loop().time()
    deadline = started + timeout
    while asyncio.get_running_loop().time() < deadline:
        if bench.connections.can_spawn_for(agent_id, room_id):
            return asyncio.get_running_loop().time() - started
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"the server still considered room {room_id} served {timeout}s after its "
        "host was killed, so no replacement could ever be started"
    )
