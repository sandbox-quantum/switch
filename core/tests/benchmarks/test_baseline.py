"""The measurement for the per-agent-connection work.

These are not pass/fail tests in the usual sense. Almost nothing here asserts a
threshold, because there is no agreed one to assert: the deliverable is a set
of figures for the topology, to be read beside the same harness run against the
topology it replaced. What *is* asserted is that the run happened — every span
has both its ends, and every message arrived exactly once — because a benchmark
that quietly measured half its workload, or measured the first of two
executions of the same work, would report a flattering number rather than a
failure.

The headline figure is the peak number of agent protocol connections one agent
holds, and it is the one thing asserted outright: one, whatever the session
count. The topology this replaced opened a stream per session on top of the
watcher's, which put a ceiling on an agent at `MAX_CONNECTIONS_PER_AGENT`
inbound connections and cost it every message addressed past that. Nothing is
refused for want of a connection now, so a message that does not arrive is a
defect rather than the shape of the topology, and is asserted against at every
scale.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tests.benchmarks.host import (
    bench_watcher,
    build_bench_bundle,
    dispatched,
    marked,
    new_marker,
)
from tests.benchmarks.server import BenchServer, RoomState
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
        # The one connection the agent's controller holds, whatever the session
        # count — the deliverable, so an equality rather than a bound. Asserted
        # on the registry count rather than the socket count because that is
        # the thing the topology change is about; the socket count is reported
        # beside it but also carries pooled HTTP traffic.
        assert result.resources.peak_streams == 1, result.resources
        # Every message arrives exactly once at every scale. There is no
        # connection ceiling left to excuse a loss, and a repeat is a message
        # whose work was done twice.
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
    assert result.resources.peak_streams == 1, result.resources
    # Arriving together must neither cost a message nor serve one twice. The
    # second is the likelier failure of the two here: messages arriving
    # together is the case where two hosts can race for the same room.
    assert result.undelivered == (), result.undelivered
    assert result.duplicated == (), result.duplicated


async def test_baseline_recovers_from_a_lost_host(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session host is killed outright; its room's messages must flow again.

    Measured because recovery is where a connection model is most likely to
    leak: the killed host's inbound stream has to be reaped and whatever serves
    the room next has to get one, and a topology that ends up holding both
    would show here as a connection count that never comes back down.

    The reap is waited for rather than assumed. Until the killed host's lease
    runs out the server still considers the room served, so a message addressed
    in that window is routed to the process that is gone — which makes the
    window itself the figure worth reporting, and makes a test that posted
    immediately measure the window instead of the recovery.

    What comes back is the same session on the same host, not a second one: a
    room held by an unfinished session is not free for anything else to take,
    so recovery here means the server naming that session as startable and the
    controller starting it again from its saved state.
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
            # The server agrees with the controller about who is working in the
            # room. It is the answer every later delivery is routed on, so a
            # recovery measured without it would be measuring the controller's
            # own bookkeeping.
            states = await bench.room_states(target.agent_id)
            assert states.get(room_id) == RoomState(assigned[room_id], ()), states
            killed = watcher.kill_session(assigned[room_id])
            assert killed > 0

            reaped = await _await_recoverable(
                bench, target.agent_id, room_id, assigned[room_id], 60.0
            )

            after = new_marker()
            markers[after] = await send(after)
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))
            # The room it still holds was served by starting that session
            # again, not by a second one started beside it.
            assert watcher.sessions_by_room()[room_id] == assigned[room_id]

        # Once, after both phases: the file is append-only and read whole, so
        # ingesting per phase would count the first phase's records twice.
        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, host killed mid-run",
        rooms=1,
        collector=collector,
        # Both messages are cold starts: the first starts the session, and the
        # second starts it again because the process serving it is gone.
        posted=Posted(markers=markers, cold=frozenset(markers.values())),
        undelivered=frozenset(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-recovery.md"))
    print(
        f"recovery: {killed} process(es) serving the session were killed outright; "
        f"the server offered the session for starting again {reaped:.1f}s later "
        "and it was serving its room by the next message"
    )
    assert result.unmeasured == ()
    # Starting the session again must not leave a second stream behind it.
    assert result.resources.peak_streams == 1, result.resources
    # The case likeliest to execute a message twice, and the reason the figure
    # is collected at all: the host is killed at a point where it may already
    # have dispatched, and a replacement then takes the room over. Recovering
    # by redoing work that was already done is not recovery.
    assert result.duplicated == (), result.duplicated


async def test_baseline_survives_a_controller_restart(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """The controller is killed and started again with deliveries outstanding.

    Two messages are exposed to the loss. One is posted immediately before the
    kill, so it may be anywhere between the server's buffer and the worker's
    hands when the controller disappears; the other is posted while there is no
    controller at all, which is the case a per-session connection never had —
    nothing else is listening for the agent, so a restart that resumed from the
    wrong place would lose it in silence.

    The assertion is exactly-once on both, and that the room is still served by
    the session that was serving it: a restarted controller re-reads its own
    journal, and one that instead started a second session for the room would
    leave two workers answering it.
    """
    target = await bench.register_agent("bench-target-restart")
    poster = await bench.register_agent("bench-poster-restart")
    await bench.start_clients(timeout=60.0)
    room_id = await bench.create_room(
        "bench-restart", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-restart"
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
        async with sampler.running("1 session, controller restarted mid-flight"):
            cold = new_marker()
            markers = {cold: await send(cold)}
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))
            assigned = watcher.sessions_by_room()
            assert room_id in assigned, assigned

            in_flight = new_marker()
            markers[in_flight] = await send(in_flight)
            watcher.stop_controller()
            # Whether the kill caught the message before it reached a provider
            # is a race, and reported rather than asserted. The exactly-once
            # claim below holds either way; this says which of the two cases
            # the run actually exercised.
            interrupted = in_flight not in dispatched(watcher, markers)

            orphaned = new_marker()
            markers[orphaned] = await send(orphaned)
            watcher.start_controller()

            assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
            # The same session, from the journal the killed controller left
            # behind — not a second one started beside a worker that never
            # stopped serving the room.
            assert watcher.sessions_by_room()[room_id] == assigned[room_id]

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, controller restarted mid-flight",
        rooms=1,
        collector=collector,
        # Only the first message pays for starting a session. The worker
        # survives the controller, so the two that follow are served warm.
        posted=Posted(markers=markers, cold=frozenset([markers[cold]])),
        undelivered=frozenset(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-controller-restart.md"))
    print(
        "controller restart: the message posted before the kill was "
        f"{'still in flight' if interrupted else 'already dispatched'} when the "
        "controller died; the message posted while there was no controller was "
        "delivered once by the one that replaced it"
    )
    assert result.unmeasured == ()
    # One connection across the restart too: a controller that left its
    # predecessor's registered behind would be two by the server's own count.
    assert result.resources.peak_streams == 1, result.resources
    assert result.duplicated == (), result.duplicated


async def _await_recoverable(
    bench: BenchServer, agent_id: str, room_id: str, session_id: str, timeout: float
) -> float:
    """Seconds until the server offers the killed session for starting again.

    Polls the session rows the admission answer is derived from rather than
    sleeping for the heartbeat TTL: the figure wanted is how long the topology
    actually holds a dead host's claim, and a fixed sleep would report the
    constant it was given.

    Waits for that one session and nothing else. A room whose session is gone
    but still named is the state recovery starts from; a room whose claim had
    simply disappeared would mean the delivery that comes next is answered by
    something other than the session the messages before it went to.
    """
    started = asyncio.get_running_loop().time()
    deadline = started + timeout
    while asyncio.get_running_loop().time() < deadline:
        state = (await bench.room_states(agent_id)).get(room_id)
        if state and state.owner is None and state.lapsed == (session_id,):
            return asyncio.get_running_loop().time() - started
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"the server still considered room {room_id} served {timeout}s after its "
        f"host was killed, so session {session_id} could never be started again"
    )
