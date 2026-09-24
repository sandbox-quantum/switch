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
import json
import os
import uuid
from pathlib import Path

import pytest

from switch_core.sessions.contract import CommandStatus
from switch_core.sessions.errors import SessionError
from tests.benchmarks.host import (
    BenchWatcher,
    bench_watcher,
    build_bench_bundle,
    controller_connection_id,
    dispatched,
    marked,
    minted_connection_id,
    new_marker,
    successor_bundle,
)
from tests.benchmarks.instrumentation import Hold
from tests.benchmarks.metrics import sample_processes
from tests.benchmarks.server import BenchCore, BenchServer, RoomState
from tests.benchmarks.trace import PROVIDER_DISPATCH, TraceCollector, correlation_for
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
    sampler_for_core,
    score,
)

pytestmark = [pytest.mark.benchmark, pytest.mark.asyncio(loop_scope="session")]

#: Session counts to measure. One is the floor the topology cannot go below;
#: fifty is past the point where a per-session connection is the dominant cost.
SCALES = (1, 10, 50)

#: Messages per room. More than one so a session's *second* message — served by
#: an already-running host rather than a cold start — is in the population.
MESSAGES_PER_ROOM = 3

#: How long a delivery the live controller cannot route is watched before it is
#: called held rather than merely slow. Several times the controller's five
#: second ownership retry, so a delivery it would have picked up on a later
#: sweep is not read as one it refused.
STRANDED_SECONDS = 20.0

#: How many times two sessions are raced into the same vacated room. The
#: ordering inside the server is not staged, so the property is held over
#: repeated attempts rather than demonstrated once.
ROOM_MOVE_ROUNDS = 3

#: How long a session is given to make its own ask for its room work, which is
#: on its own interval. Several times that interval, so an ask delayed by a
#: busy loop is waited out rather than read as one never made.
ASK_HELD_SECONDS = 30.0

#: How long an accepted command is given to reach a session and be applied.
CONTROL_SECONDS = 30.0

#: How long a population of served, idle sessions is watched for the requests
#: it makes anyway. Six of a worker's five second renewals, so what happens
#: once per renewal is counted several times over rather than caught once.
IDLE_SECONDS = 30.0


#: Environment variable naming a bench host bundle built from a checkout of the
#: topology this work replaced.
LEGACY_BUNDLE_VARIABLE = "SWITCH_BENCH_LEGACY_BUNDLE"


@pytest.fixture(scope="session")
def bundle() -> Path:
    return build_bench_bundle()


@pytest.fixture(scope="session")
def legacy_bundle() -> Path:
    """The bundle of the build this topology replaced.

    Built from a second checkout, whose location is a property of the machine
    rather than of the repository, so it is named in the environment. Without
    it the upgrade is skipped and said to be skipped, rather than stood in for
    by a current build pretending to be an old one — the whole property being
    measured is what two different builds do to one agent.
    """
    named = os.environ.get(LEGACY_BUNDLE_VARIABLE)
    if not named:
        pytest.skip(
            f"set {LEGACY_BUNDLE_VARIABLE} to a bench host bundle built from a "
            "checkout of the previous topology to measure an upgrade over it"
        )
    supplied = Path(named)
    if not supplied.is_file():
        raise RuntimeError(
            f"{LEGACY_BUNDLE_VARIABLE} names {supplied}, which is not a file"
        )
    return supplied


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
        connection_id=controller_connection_id(target.agent_id),
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


async def test_baseline_idles_at_session_count(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """What 1, 10 and 50 served sessions ask of the server while nothing happens.

    Each room is sent one message so that its session exists, has answered and
    is idle, and the server is then watched for `IDLE_SECONDS` with nothing
    addressed to anyone. Every request it is sent in that window is counted by
    route, beside the statements it sends its database and the CPU the driver
    process (which hosts the server) and the agent's process tree used.

    Requests are counted rather than inferred, and CPU is reported beside them
    rather than derived from them: fewer requests are not by themselves a
    cheaper idle. After the window one more message is addressed, so a quieter
    idle is seen not to have cost the next delivery its latency.
    """
    lines: list[str] = []
    for rooms in SCALES:
        target = await bench.register_agent(f"bench-target-idle-{rooms}")
        poster = await bench.register_agent(f"bench-poster-idle-{rooms}")
        await bench.start_clients(timeout=60.0)
        room_ids = [
            await bench.create_room(
                f"bench-idle-{rooms}-{index}", [target.agent_id, poster.agent_id]
            )
            for index in range(rooms)
        ]
        home = tmp_path / f"home-idle-{rooms}"
        home.mkdir(parents=True)

        async def send(room: str, marker: str) -> str:
            return correlation_for(
                room,
                await bench.address(
                    sender=poster,
                    room_id=room,
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
            connection_id=controller_connection_id(target.agent_id),
        ) as watcher:
            await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
            markers: dict[str, str] = {}
            for room in room_ids:
                marker = new_marker()
                markers[marker] = await send(room, marker)
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(rooms))
            assert len(watcher.sessions_by_room()) == rooms
            # Past the turn each session just finished, so what is counted is
            # idling rather than the tail of the work.
            await asyncio.sleep(5.0)

            clock = asyncio.get_running_loop()
            pids = [os.getpid(), *watcher.process_tree()]
            cpu_before = sample_processes(pids)
            requests_before = bench.requests.counts.copy()
            statements_before = bench.statements["statements"]
            started = clock.time()
            await asyncio.sleep(IDLE_SECONDS)
            watched = clock.time() - started
            requests = bench.requests.counts - requests_before
            statements = bench.statements["statements"] - statements_before
            cpu_after = sample_processes(pids)

            def cpu(chosen: list[int]) -> float:
                return sum(
                    cpu_after[pid].cpu_seconds - cpu_before[pid].cpu_seconds
                    for pid in chosen
                    if pid in cpu_before and pid in cpu_after
                )

            addressed = new_marker()
            markers[addressed] = await send(room_ids[0], addressed)
            sent = clock.time()
            assert not await dispatch_wait(
                watcher, {addressed: markers[addressed]}, dispatch_timeout(1)
            )
            latency = clock.time() - sent
            assert watcher.failure() is None, watcher.failure()
            collector.ingest_jsonl(watcher.trace_path, markers)

        routes = ", ".join(
            f"{route} {count}" for route, count in sorted(requests.items())
        )
        lines.append(
            f"{rooms} idle session(s) over {watched:.1f}s: "
            f"renew {requests['sessions/renew']}, "
            f"room-reservations {requests['sessions/room-reservations']}, "
            f"all requests {sum(requests.values())} ({routes}); "
            f"{statements} database statements; CPU driver "
            f"{cpu(pids[:1]):.2f}s, agent processes {cpu(pids[1:]):.2f}s; "
            f"next addressed message dispatched in {latency:.2f}s"
        )
        print("\nidle: " + lines[-1])
    print("\nidle summary:\n" + "\n".join(lines))


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
        connection_id=controller_connection_id(target.agent_id),
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


async def test_baseline_recovers_from_a_lost_worker(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """The worker serving a room dies; its supervisor brings it straight back.

    Distinct from losing the whole host: the supervisor and the controller both
    survive, so nothing waits for a lease to lapse and the room is never
    offered to anything else. The room comes back in seconds rather than after
    the reap, which makes this the case where two ways of reaching the worker
    are live at once — the controller still routes what the server pushes it,
    and the worker that comes back asks Switch for what its own rooms are owed.

    So the claim is exactly-once with both paths running, on messages the kill
    is aimed at: one posted immediately before it, which may be anywhere
    between the server and the provider, and one posted while there is no
    worker at all. The room must still be served by the same session, on the
    conversation it had, because a worker that came back as a new conversation
    would have lost the thread it was answering.
    """
    target = await bench.register_agent("bench-target-worker")
    poster = await bench.register_agent("bench-poster-worker")
    await bench.start_clients(timeout=60.0)
    room_id = await bench.create_room(
        "bench-worker", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-worker"
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
        connection_id=controller_connection_id(target.agent_id),
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        cold = new_marker()
        markers = {cold: await send(cold)}
        assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))
        assigned = watcher.sessions_by_room()
        assert room_id in assigned, assigned

        in_flight = new_marker()
        markers[in_flight] = await send(in_flight)
        killed = watcher.kill_worker(assigned[room_id])
        # Reported rather than asserted: whether the kill caught the message
        # before a provider saw it is a race, and the exactly-once claim below
        # holds either way. This says which case the run exercised.
        interrupted = in_flight not in dispatched(watcher, markers)

        orphaned = new_marker()
        markers[orphaned] = await send(orphaned)
        assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
        assert watcher.sessions_by_room()[room_id] == assigned[room_id]
        conversations = set(watcher.provider_conversations(assigned[room_id]))
        assert len(conversations) == 1, conversations
        # Nothing is left owed: a worker that came back and answered what it
        # was pushed, while Switch still held a promise for the same message,
        # would be a delivery waiting to be made a second time.
        reserved = await bench.reserved_deliveries(target.agent_id)
        assert not {_message_of(markers[m]) for m in markers} & set(reserved), reserved
        # One connection throughout: the worker is not what holds it, so a
        # relaunch that opened its own would be a connection per session again.
        held = bench.connections.for_agent(target.agent_id)
        assert len(held) == 1, held

        collector.ingest_jsonl(watcher.trace_path, markers)

    duplicated = collector.subset(set(markers.values())).repeats(PROVIDER_DISPATCH)
    print(
        f"lost worker: {killed} worker process(es) were killed under a supervisor "
        "and a controller that both survived; the message posted before the kill "
        f"was {'still in flight' if interrupted else 'already dispatched'}, the "
        "message posted while there was no worker was delivered once, and the room "
        f"came back on the session ({assigned[room_id]}) and conversation "
        "it already had."
    )
    assert duplicated == {}, duplicated


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
        connection_id=controller_connection_id(target.agent_id),
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
            watcher.start_controller(watcher.bundle, watcher.connection_id)

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


async def test_baseline_survives_a_core_restart(
    core: BenchCore, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Switch itself is restarted while a delivery is reserved and unmade.

    The controller and its workers are left running and the database is kept;
    what goes is the Core and everything it held in memory, the replay buffer
    above all. That is the arrangement the reservation exists for: a delivery
    the agent has been promised lives in a row rather than in the buffer, so a
    Core that comes back with an empty buffer must still let that delivery be
    made, exactly once.

    The restart is staged on a reservation the database actually shows, not on
    a sleep timed to where one is thought to be. A cold room is used for it
    because a session being started is the longest the promise is outstanding.
    """
    bench = core.server
    target = await bench.register_agent("bench-target-core")
    poster = await bench.register_agent("bench-poster-core")
    await bench.start_clients(timeout=60.0)
    warm_room = await bench.create_room(
        "bench-core-warm", [target.agent_id, poster.agent_id]
    )
    held_room = await bench.create_room(
        "bench-core-held", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-core"
    home.mkdir(parents=True)

    async def send(room_id: str, marker: str) -> str:
        return correlation_for(
            room_id,
            await core.server.address(
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
        connection_id=controller_connection_id(target.agent_id),
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for_core(core, watcher, target.agent_id)
        async with sampler.running("1 session, Core restarted mid-delivery"):
            warm = new_marker()
            markers = {warm: await send(warm_room, warm)}
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))
            assigned = watcher.sessions_by_room()
            assert warm_room in assigned, assigned

            settled = await bench.reserved_deliveries(target.agent_id)
            held = new_marker()
            markers[held] = await send(held_room, held)
            reserved = await _await_reservation(bench, target.agent_id, settled, 30.0)
            emptied = bench.event_buffer

            await core.restart()
            # The buffer really is gone: a restart that inherited it would
            # prove nothing about the promise surviving on its own.
            assert core.server.event_buffer is not emptied
            await core.server.start_clients(timeout=60.0)
            reconnected = await _await_reconnection(
                core, target.agent_id, STREAM_TIMEOUT_SECONDS
            )
            # One connection on the replacement, not a second one alongside a
            # registration the restart left behind.
            assert len(core.server.connections.for_agent(target.agent_id)) == 1

            assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
            served = watcher.sessions_by_room()
            # The room that was already being served is still served by the
            # same session, and the reserved delivery was made by one session
            # rather than by one the restart started beside it.
            assert served[warm_room] == assigned[warm_room]
            assert held_room in served, served

            # The topology works after the restart, not merely through it.
            resumed = new_marker()
            markers[resumed] = await send(held_room, resumed)
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, Core restarted mid-delivery",
        rooms=2,
        collector=collector,
        # Both rooms pay for a session to be started; only the last message is
        # served by a session that was already running.
        posted=Posted(markers=markers, cold=frozenset([markers[warm], markers[held]])),
        undelivered=frozenset(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-core-restart.md"))
    print(
        f"core restart: {len(reserved)} delivery reservation(s) were outstanding "
        f"when the Core was replaced ({', '.join(reserved)}); the agent was "
        f"connected to the new one {reconnected:.1f}s later and the reserved "
        "delivery was made once"
    )
    assert result.unmeasured == ()
    # One connection across the restart as well as through it: the sampler
    # counted streams on whichever Core was serving at the time.
    assert result.resources.peak_streams == 1, result.resources
    assert result.undelivered == (), result.undelivered
    assert result.duplicated == (), result.duplicated


async def test_baseline_settles_two_competing_controllers(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Two controllers are started for one agent, as two Consoles would be.

    A controller's connection is derived from the agent it controls, so the
    second one does not open a connection beside the first: it reopens the
    same one, and the server hands it over. What is asserted is that the
    handover settles — the loser stands down durably and stays down, the agent
    holds one connection throughout, and nothing is served twice — because two
    controllers that each reclaimed the connection from the other would also,
    at any single moment, look like one.

    A room the loser was serving does not come with it: the winner cannot route
    to a session it did not start, and on two machines it cannot read the saved
    state that session would be revived from either. What it does not need to
    do is wait to be routed to. The session is still in the room, still holding
    its lease, and asks Switch for the work its own rooms owe it, so the
    message is answered by the session that was already there rather than by
    the controller that took the connection.

    Once that session is gone the room is held by one only the loser could
    start again, and a message addressed to it is held by Switch instead —
    still not lost, still not served twice, and still not migrated to the
    winner. Both halves are asserted here, beside a room the winner picks up
    normally, so what the takeover costs is pinned to a room whose worker is
    dead rather than to the takeover itself.

    Latency is not scored. The arrangement is two controllers on one agent,
    which is not a topology anybody runs deliberately; what it has to do is
    settle without losing a message, not be fast.
    """
    target = await bench.register_agent("bench-target-compete")
    poster = await bench.register_agent("bench-poster-compete")
    await bench.start_clients(timeout=60.0)
    room_id = await bench.create_room(
        "bench-compete", [target.agent_id, poster.agent_id]
    )
    fresh_room = await bench.create_room(
        "bench-compete-fresh", [target.agent_id, poster.agent_id]
    )
    first_home = tmp_path / "home-compete-first"
    first_home.mkdir(parents=True)
    second_home = tmp_path / "home-compete-second"
    second_home.mkdir(parents=True)

    async def send(room: str, marker: str) -> str:
        return correlation_for(
            room,
            await bench.address(
                sender=poster,
                room_id=room,
                target=target.name,
                body=f"@{target.name} {marked(marker)}",
            ),
        )

    with bench_watcher(
        bundle=bundle,
        home=first_home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
        connection_id=controller_connection_id(target.agent_id),
    ) as first:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        served = new_marker()
        markers = {served: await send(room_id, served)}
        assert not await dispatch_wait(
            first, {served: markers[served]}, dispatch_timeout(1)
        )
        assigned = first.sessions_by_room()
        assert room_id in assigned, assigned
        assert len(bench.connections.for_agent(target.agent_id)) == 1

        try:
            with bench_watcher(
                bundle=bundle,
                home=second_home,
                base_url=bench.base_url,
                agent_id=target.agent_id,
                api_key=target.api_key,
                connection_id=controller_connection_id(target.agent_id),
            ) as second:
                stood_down = await _await_takeover(first, STREAM_TIMEOUT_SECONDS)
                assert stood_down["connectionId"] == controller_connection_id(
                    target.agent_id
                )
                assert stood_down["reason"], stood_down

                # The connection the winner holds is the one the loser had, so
                # the id says the handover happened rather than that a second
                # connection was opened somewhere the first could not see it.
                held = bench.connections.for_agent(target.agent_id)
                assert len(held) == 1, held
                assert held[0].id == controller_connection_id(target.agent_id)

                carried = new_marker()
                markers[carried] = await send(room_id, carried)
                sent = asyncio.get_running_loop().time()
                # Answered by the session that is in the room, which asked for
                # it rather than waiting to be handed it. The same session as
                # before the takeover, running the conversation it already had.
                assert not await dispatch_wait(
                    first, {carried: markers[carried]}, STRANDED_SECONDS
                )
                discovered = asyncio.get_running_loop().time() - sent
                # Not the winner's to answer: the room is held by a session it
                # did not start and has no route to.
                assert await dispatch_wait(
                    second, {carried: markers[carried]}, STRANDED_SECONDS
                ) == frozenset([markers[carried]])
                assert first.sessions_by_room()[room_id] == assigned[room_id]
                conversations = set(first.provider_conversations(assigned[room_id]))
                assert len(conversations) == 1, conversations
                (conversation,) = conversations
                # Made rather than still owed: the promise is consumed, so
                # nothing is left for a controller to serve a second time.
                reserved = await bench.reserved_deliveries(target.agent_id)
                assert _message_of(markers[carried]) not in reserved, reserved

                # Settled, not merely handed over once: a loser that reopened
                # the connection would take it back, and the two would trade it
                # for as long as both were running.
                counts = await _connection_counts(bench, target.agent_id, 10.0)
                assert set(counts) == {1}, counts
                assert second.taken_over() is None, second.taken_over()
                assert not first.controller_running()
                assert first.failure() is None, first.failure()

                # The losing machine's workers go away, as they would when its
                # Console is closed, and the server stops calling the room
                # served. With nothing left in the room to ask for the work,
                # what is addressed to it is held: reviving that session needs
                # the state the loser saved, and no state moves between
                # machines.
                orphaned = first.kill_sessions()
                lapsed = await _await_recoverable(
                    bench, target.agent_id, room_id, assigned[room_id], 120.0
                )
                stranded = new_marker()
                markers[stranded] = await send(room_id, stranded)
                assert await dispatch_wait(
                    second, {stranded: markers[stranded]}, STRANDED_SECONDS
                ) == frozenset([markers[stranded]])
                assert room_id not in second.sessions_by_room()
                still_reserved = await bench.reserved_deliveries(target.agent_id)
                assert _message_of(markers[stranded]) in still_reserved

                # A room the loser never served is the winner's to serve, so
                # what the takeover stranded is that room rather than the agent.
                fresh = new_marker()
                markers[fresh] = await send(fresh_room, fresh)
                assert not await dispatch_wait(
                    second, {fresh: markers[fresh]}, dispatch_timeout(1)
                )

                collector.ingest_jsonl(second.trace_path, markers)
        finally:
            # The loser's workers outlive it either way: it stands down without
            # stopping them, and nothing else is their parent.
            first.kill_sessions()
        collector.ingest_jsonl(first.trace_path, markers)

    duplicated = collector.subset(set(markers.values())).repeats(PROVIDER_DISPATCH)
    print(
        f"competing controllers: the first stood down ({stood_down['reason']}) when "
        "the second took its connection, and stayed down. A message addressed to "
        "the room the first was serving was not the winner's to route, and was "
        f"answered by the session already in it ({assigned[room_id]}) "
        f"{discovered:.2f}s after it was sent, which asked "
        "Switch for the work its own rooms owed it and kept the provider "
        f"conversation it had ({conversation}). Killing that controller's "
        f"{orphaned} worker process(es) freed the room's claim {lapsed:.1f}s later, "
        "and the next message to that room is held, because the session that holds "
        "it can only be started again by the controller that saved it. A room the "
        "first never served was delivered to normally."
    )
    assert duplicated == {}, duplicated


async def test_baseline_upgrades_over_a_running_legacy_session(
    bench: BenchServer,
    collector: TraceCollector,
    bundle: Path,
    legacy_bundle: Path,
    tmp_path: Path,
) -> None:
    """A session left running by the build this replaced meets a new controller.

    This is the state an in-place upgrade leaves on a machine. The app that was
    running gave the session a connection of its own; it is replaced by a build
    whose controller holds the agent's only connection, and the session it left
    behind is still up, still answering its room over a connection the new
    controller never opened. Nothing coordinates the two but the state root
    they share.

    The agent comes back to one connection and the room does not go quiet:
    every message is delivered exactly once, and a room first addressed after
    the upgrade is served normally. The room keeps its session too. The old
    build recorded nothing of the room against the session, so what says the
    session was serving it is the connection the old worker is still holding:
    the new controller has Switch write that down before it replaces the
    worker, and the next message is answered by the same session with the same
    conversation behind it.

    The old controller is killed rather than asked to quit, so the connection
    it held is swept on its heartbeat instead of being closed. That is the
    upgrade a crashed app leaves and the slower of the two to settle; how much
    sooner a clean quit gives the connection back is not measured here.
    """
    target = await bench.register_agent("bench-target-upgrade")
    poster = await bench.register_agent("bench-poster-upgrade")
    await bench.start_clients(timeout=60.0)
    served_room = await bench.create_room(
        "bench-upgrade-served", [target.agent_id, poster.agent_id]
    )
    later_room = await bench.create_room(
        "bench-upgrade-later", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-upgrade"
    home.mkdir(parents=True)

    async def send(room: str, marker: str) -> str:
        return correlation_for(
            room,
            await bench.address(
                sender=poster,
                room_id=room,
                target=target.name,
                body=f"@{target.name} {marked(marker)}",
            ),
        )

    markers: dict[str, str] = {}
    with bench_watcher(
        bundle=legacy_bundle,
        home=home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
        connection_id=minted_connection_id(),
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        before = new_marker()
        markers[before] = await send(served_room, before)
        assert not await dispatch_wait(
            watcher, {before: markers[before]}, dispatch_timeout(1)
        )
        assigned = watcher.sessions_by_room()
        assert served_room in assigned, assigned
        # The topology being upgraded from, in the state it leaves behind: the
        # controller's connection, and one the session opened for itself.
        _, legacy = await _await_connections(
            bench, target.agent_id, 2, watcher.connection_id, 30.0
        )

        watcher.stop_controller()
        watcher.start_controller(bundle, controller_connection_id(target.agent_id))
        settled, _ = await _await_connections(
            bench, target.agent_id, 1, controller_connection_id(target.agent_id), 180.0
        )

        after = new_marker()
        markers[after] = await send(served_room, after)
        assert not await dispatch_wait(
            watcher, {after: markers[after]}, dispatch_timeout(1)
        )
        # Answered by the session that had been serving the room since before
        # the upgrade, rather than by one started for this message.
        serving = watcher.sessions_by_room()[served_room]
        assert serving == assigned[served_room]
        # And by the conversation it was already having. Keeping the server's
        # session identity and starting a new provider conversation under it
        # would read to the room as the same loss.
        conversations = watcher.provider_conversations(serving)
        assert len(set(conversations)) == 1, conversations
        assert len(conversations) > 1, conversations

        fresh = new_marker()
        markers[fresh] = await send(later_room, fresh)
        assert not await dispatch_wait(
            watcher, {fresh: markers[fresh]}, dispatch_timeout(1)
        )
        assert watcher.failure() is None, watcher.failure()
        collector.ingest_jsonl(watcher.trace_path, markers)

    duplicated = collector.subset(set(markers.values())).repeats(PROVIDER_DISPATCH)
    print(
        f"upgrade over a running session: the agent held {len(legacy)} connections "
        "under the build being replaced — the controller's and the session's own — "
        f"and was back to one, the controller's, {settled:.1f}s after a newer "
        "controller was started on the same state. Every message was delivered "
        "once, and a room first addressed after the upgrade was served normally. "
        "The room the older build had been serving kept its session: Switch was "
        f"told the room was {assigned[served_room]}'s while that session was "
        "still serving it over a connection of its own, and only then was it "
        f"restarted, so the next message there was answered by {serving}, "
        "resuming the provider conversation it already had "
        f"({conversations[0]}) rather than beginning another."
    )
    assert duplicated == {}, duplicated


async def test_baseline_upgrades_over_its_own_running_session(
    bench: BenchServer,
    collector: TraceCollector,
    bundle: Path,
    tmp_path: Path,
) -> None:
    """One release of this topology replaced by the next, over a served room.

    The separate half of the upgrade the legacy scenario measures. There the
    session being inherited was started by a build that kept its room set in a
    local file and claimed nothing on the server, so the room it served was
    never the server's to hand on. Here the session being inherited is this
    topology's own: it claimed its room against the server, and the claim is
    durable state the controller restarting it has no part in.

    So the room keeps its session, and that is asserted as equality. Saying it
    separately is the point of the scenario — a single test spanning both
    builds could not tell a topology that loses rooms on every upgrade apart
    from one that loses them only when inheriting a build that never held them.

    The two builds are the same bundle at two paths, because a build identity
    is the path the daemon was started from. Identical code under two
    identities is exactly the upgrade a release performs over the one before
    it, and unlike the legacy case it needs no second checkout.
    """
    target = await bench.register_agent("bench-target-successor")
    poster = await bench.register_agent("bench-poster-successor")
    await bench.start_clients(timeout=60.0)
    served_room = await bench.create_room(
        "bench-successor-served", [target.agent_id, poster.agent_id]
    )
    later_room = await bench.create_room(
        "bench-successor-later", [target.agent_id, poster.agent_id]
    )
    home = tmp_path / "home-successor"
    home.mkdir(parents=True)
    successor = successor_bundle(bundle)

    async def send(room: str, marker: str) -> str:
        return correlation_for(
            room,
            await bench.address(
                sender=poster,
                room_id=room,
                target=target.name,
                body=f"@{target.name} {marked(marker)}",
            ),
        )

    markers: dict[str, str] = {}
    connection = controller_connection_id(target.agent_id)
    with bench_watcher(
        bundle=bundle,
        home=home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
        connection_id=connection,
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        before = new_marker()
        markers[before] = await send(served_room, before)
        assert not await dispatch_wait(
            watcher, {before: markers[before]}, dispatch_timeout(1)
        )
        assigned = watcher.sessions_by_room()
        assert served_room in assigned, assigned

        watcher.stop_controller()
        watcher.start_controller(successor, connection)
        settled, _ = await _await_connections(
            bench, target.agent_id, 1, connection, 180.0
        )

        after = new_marker()
        markers[after] = await send(served_room, after)
        assert not await dispatch_wait(
            watcher, {after: markers[after]}, dispatch_timeout(1)
        )
        serving = watcher.sessions_by_room()[served_room]
        assert serving == assigned[served_room], (serving, assigned[served_room])
        # Continuity has two halves and the delivery above proves neither. The
        # server's session identity is the claim that survived the upgrade;
        # the provider conversation is what the room is actually talking to. A
        # host that restarted the session but began a new conversation would
        # satisfy the first and fail the room, so both are asserted.
        conversations = watcher.provider_conversations(serving)
        assert len(set(conversations)) == 1, conversations
        # More than one start, so the identity above is a conversation that was
        # resumed rather than one that was never interrupted. How many is not
        # asserted: that is the host's business and would make this brittle.
        assert len(conversations) > 1, conversations

        fresh = new_marker()
        markers[fresh] = await send(later_room, fresh)
        assert not await dispatch_wait(
            watcher, {fresh: markers[fresh]}, dispatch_timeout(1)
        )
        assert watcher.failure() is None, watcher.failure()
        collector.ingest_jsonl(watcher.trace_path, markers)

    duplicated = collector.subset(set(markers.values())).repeats(PROVIDER_DISPATCH)
    print(
        "upgrade between two builds of this topology: the agent held one "
        f"connection throughout and was settled on it {settled:.1f}s after the "
        "successor controller started on the same state. The room kept the "
        f"session that had been serving it, {serving}, and that session resumed "
        f"the provider conversation it already had ({conversations[0]}) rather "
        "than beginning another, so its next message was answered with the "
        "conversation behind it. Every message was delivered once, and a room "
        "first addressed after the upgrade was served normally."
    )
    assert duplicated == {}, duplicated


async def test_baseline_settles_two_sessions_taking_one_room(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Two sessions of one agent move into the same vacated room at once.

    They share the agent's one connection, so the room is recorded in two
    places that have to agree: the session rows, which say who owns it and
    therefore who a delivery is routed to, and the connection registry, which
    says the room is claimed on the connection the events travel over. A move
    is both — the session that arrives takes the room, and the session that
    leaves gives up the rooms it held — and two of them moving at once is the
    case where one caller's tidying up can be about the state the other has
    already replaced.

    What is asserted each round is that the two answers are the same answer:
    the room has an owner, that owner is one of the two callers, the room is
    claimed on the agent's connection rather than left on none of them, and
    exactly one caller is told it took the room off the other. Then a message
    posted to the room is served once, by the session that owns it, which is
    the part a disagreement between the two records costs.

    The interleaving itself is not staged. Nothing outside the server can
    suspend a caller between its bind committing and its registry work, so what
    a live run can do is race the two callers repeatedly and hold the invariant
    each time; the ordering is staged deterministically in
    `tests/switch_core/sessions/test_connect_room_ordering.py`, against the
    same operation.
    """
    target = await bench.register_agent("bench-target-move")
    poster = await bench.register_agent("bench-poster-move")
    await bench.start_clients(timeout=60.0)
    rooms = [
        await bench.create_room(
            f"bench-move-{index}", [target.agent_id, poster.agent_id]
        )
        for index in range(3)
    ]
    home = tmp_path / "home-move"
    home.mkdir(parents=True)

    async def send(room_id: str, marker: str) -> str:
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
        connection_id=controller_connection_id(target.agent_id),
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        markers: dict[str, str] = {}
        for room_id in rooms[:2]:
            marker = new_marker()
            markers[marker] = await send(room_id, marker)
        assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
        assigned = watcher.sessions_by_room()
        sessions = [assigned[room_id] for room_id in rooms[:2]]
        assert len(set(sessions)) == 2, assigned

        owner: str | None = None
        contested = rooms[2]
        for round_number in range(ROOM_MOVE_ROUNDS):
            selectors = await bench.session_selectors(target.agent_id)
            answers = await asyncio.gather(
                *(
                    bench.connect_session_to_room(
                        agent=target, selector=selectors[session], room_id=contested
                    )
                    for session in sessions
                )
            )

            states = await bench.room_states(target.agent_id)
            owner = states[contested].owner
            assert owner in sessions, (round_number, owner, sessions)
            held = bench.connections.for_agent(target.agent_id)
            assert len(held) == 1, held
            claimed = bench.connections.claimant_of(target.agent_id, contested)
            assert claimed is not None and claimed.id == held[0].id, (
                round_number,
                claimed,
                held,
            )

            warnings = [answer for answer in answers if answer["warning"] is not None]
            assert len(warnings) == 1, [answer["warning"] for answer in answers]
            assert sessions[answers.index(warnings[0])] == owner, warnings[0]
            displaced = next(session for session in sessions if session != owner)
            assert displaced in warnings[0]["warning"], warnings[0]["warning"]

            contested = rooms[(rooms.index(contested) + 1) % len(rooms)]

        settled = rooms[(rooms.index(contested) - 1) % len(rooms)]
        after = new_marker()
        markers[after] = await send(settled, after)
        assert not await dispatch_wait(
            watcher, {after: markers[after]}, dispatch_timeout(1)
        )
        assert watcher.sessions_by_room()[settled] == owner, watcher.sessions_by_room()
        reserved = await bench.reserved_deliveries(target.agent_id)
        assert _message_of(markers[after]) not in reserved, reserved
        assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    duplicated = collector.subset(set(markers.values())).repeats(PROVIDER_DISPATCH)
    print(
        f"two sessions taking one room: {ROOM_MOVE_ROUNDS} rounds of both "
        "sessions of one agent moving into the same vacated room at the same "
        "time. Every round left the room with one owning session and the room "
        "claimed on the agent's single connection, and told exactly one caller "
        "it had taken the room off the other. The message posted afterwards was "
        f"served once by the session that owned the room ({owner})."
    )
    assert duplicated == {}, duplicated


async def test_baseline_serves_a_room_while_its_own_ask_is_stalled(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session's ask for its own room work never answers; the rest carries on.

    The ask is a session's fallback for work its controller did not route to
    it, and it is made against a server that can be slow or gone. Held open at
    the socket, before the request reaches a route, it is the same thing a
    session sees when an answer is never coming: its own request outstanding,
    and no say in when it ends.

    What must not depend on it is everything the session is reached by
    otherwise — a delivery its controller pushes, and a command submitted for
    it. Both are timed, and asserted to have happened while the session was
    still waiting on its own ask rather than after its client had given up on
    one: the client sets its own timeout, so a request held past it is held on
    nobody's behalf and proves nothing about what the session was doing
    meanwhile. The gate watches for the disconnect that timeout sends, and the
    hold is then deliberately kept past it, so the same watch that reported a
    wait is seen to report the end of one. Never more than one ask is waited on
    at a time — a session that started another on each interval would be
    piling up requests against a server already failing to answer.

    Then the hold is let go, and the work it was holding is not done twice.
    """
    target = await bench.register_agent("bench-target-stall")
    poster = await bench.register_agent("bench-poster-stall")
    await bench.start_clients(timeout=60.0)
    room_id = await bench.create_room("bench-stall", [target.agent_id, poster.agent_id])
    home = tmp_path / "home-stall"
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
        connection_id=controller_connection_id(target.agent_id),
    ) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        cold = new_marker()
        markers = {cold: await send(cold)}
        assert not await dispatch_wait(watcher, markers, dispatch_timeout(1))
        session = watcher.sessions_by_room()[room_id]

        clock = asyncio.get_running_loop()
        bench.stalls.arm()
        try:
            # A session asks only once its renewal says its rooms are owed
            # something, and a served room owes nothing; this is what it is
            # owed, so the ask that is held is one the session had reason to
            # make.
            await bench.owe_lapsed_delivery(target.agent_id, room_id)
            arrived = await bench.stalls.await_held(ASK_HELD_SECONDS)

            pushed = new_marker()
            markers[pushed] = await send(pushed)
            assert not await dispatch_wait(
                watcher, {pushed: markers[pushed]}, dispatch_timeout(1)
            )
            served_at = clock.time()

            receipt = await _control_when_idle(
                bench,
                agent_id=target.agent_id,
                room_id=room_id,
                message_id=str(uuid.uuid4()),
                timeout=CONTROL_SECONDS,
            )
            assert receipt.status == "accepted", receipt
            outcome = await _await_command(
                bench, session, receipt.command_id, CONTROL_SECONDS
            )
            assert outcome == "applied", outcome
            applied_at = clock.time()
            # What the control was for, rather than only its bookkeeping: a
            # reset is the session's conversation being started again, so a
            # second conversation on the same session is the work being done.
            conversations = watcher.provider_conversations(session)
            assert len(set(conversations)) == 2, conversations

            # The two above happened while the session was still waiting on its
            # own ask, rather than after its client had given up on it and
            # moved on — which a gate that merely held the request would report
            # identically. Each is timed against the disconnect the client
            # sends when it abandons the request.
            assert bench.stalls.live_at(served_at), (served_at, bench.stalls.holds())
            assert bench.stalls.live_at(applied_at), (applied_at, bench.stalls.holds())

            # Which is only worth asserting if the gate can tell the difference,
            # so it is made to: held past the client's own timeout, the ask is
            # given up on, and the moment that happened is observed rather than
            # assumed. It is after both of the above, which is what "still
            # waiting" at those moments meant.
            abandoned = await bench.stalls.await_abandoned(ASK_HELD_SECONDS)
            assert abandoned > applied_at, (abandoned, applied_at)
            assert not bench.stalls.live_at(abandoned), bench.stalls.holds()

            # And one ask at a time: the next was made only once the last had
            # been given up on, rather than piled on a server already failing
            # to answer.
            holds = bench.stalls.holds()
            assert bench.stalls.concurrent_peak() == 1, holds
        finally:
            bench.stalls.release()

        released = new_marker()
        markers[released] = await send(released)
        assert not await dispatch_wait(
            watcher, {released: markers[released]}, dispatch_timeout(1)
        )
        assert watcher.sessions_by_room()[room_id] == session
        # The ask answers what is outstanding, and what was already served is
        # not outstanding: a delivery still promised here is one the released
        # ask is about to offer the session a second time.
        reserved = await bench.reserved_deliveries(target.agent_id)
        assert not {_message_of(markers[m]) for m in markers} & set(reserved), reserved
        held = bench.connections.for_agent(target.agent_id)
        assert len(held) == 1, held
        assert watcher.failure() is None, watcher.failure()

        followups = _server_originated_dispatches(watcher.trace_path)
        assert len(followups) == 1, followups
        collector.ingest_jsonl(watcher.trace_path, {**markers, **followups})

    scored = set(markers.values()) | set(followups)
    duplicated = collector.subset(scored).repeats(PROVIDER_DISPATCH)
    print(
        "stalled ask: with the session's own ask for its room work held open "
        "and unanswered, a pushed delivery was served and a room control "
        f"command was applied to the same session ({session}). Measured from "
        "the first ask being held: delivery served at "
        f"{served_at - arrived:.2f}s, reset applied at "
        f"{applied_at - arrived:.2f}s, both while that ask was still being "
        f"waited on — the client gave up on it at {abandoned - arrived:.2f}s, "
        "observed rather than assumed. Never more than one ask at a time "
        f"({_held_summary(holds, arrived)}). The applied reset "
        "queued the session one follow-up of Switch's own, served once. "
        "Letting the ask go re-executed nothing, and the room was served "
        "normally afterwards."
    )
    assert duplicated == {}, duplicated


def _held_summary(holds: tuple[Hold, ...], origin: float) -> str:
    """Each held ask as the window its client actually waited through."""
    return ", ".join(
        f"{hold.arrived - origin:.2f}s→"
        + (
            "still waiting"
            if hold.abandoned is None
            else f"{hold.abandoned - origin:.2f}s"
        )
        for hold in holds
    )


def _server_originated_dispatches(trace_path: Path) -> dict[str, str]:
    """Labels for dispatches Switch caused itself, each mapped onto itself.

    An applied room control has a consequence of its own: the session is queued
    a follow-up, and the host serves it like any other work. The driver never
    sent it, so the host labels it as an unmarked turn, and scoring rejects a
    label it cannot place — a host dispatching work nobody asked for is exactly
    what that rule is for. Naming these leaves the rule in force for everything
    else and scores them under an identity of their own, so a follow-up served
    twice still reads as a repeat.
    """
    if not trace_path.exists():
        return {}
    labels = {
        str(json.loads(line)["correlation"])
        for line in trace_path.read_text().splitlines()
        if line.strip()
    }
    return {label: label for label in labels if label.startswith("unmarked:")}


async def _control_when_idle(
    bench: BenchServer, *, agent_id: str, room_id: str, message_id: str, timeout: float
) -> CommandStatus:
    """Submit a room reset, waiting out a turn the session is still finishing.

    A control is refused while the session is working, which is the server's
    answer rather than something to be worked around; what is waited for is the
    turn the scenario itself caused a moment earlier. The message id is the
    same on every attempt, so a submission that was accepted and then looked
    refused cannot become two controls.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        try:
            return await bench.room_control(
                agent_id=agent_id,
                room_id=room_id,
                action="reset",
                message_id=message_id,
            )
        except SessionError as error:
            if error.code != "SESSION_BUSY" or loop.time() > deadline:
                raise
        await asyncio.sleep(0.2)


async def _await_command(
    bench: BenchServer, session_id: str, command_id: str, timeout: float
) -> str:
    """Poll a submitted command until the server confirms it, or time runs out.

    `unknown` is not taken as settled here. A control that takes the session to
    a new epoch passes through it — an epoch change marks every command not yet
    confirmed unknown, this one included — and the host's own result for it
    follows.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        outcome = await bench.control_outcome(
            session_id=session_id, command_id=command_id
        )
        if outcome in ("applied", "rejected") or loop.time() > deadline:
            return outcome
        await asyncio.sleep(0.2)


def _message_of(correlation: str) -> str:
    """The message id half of a correlation, as the watcher journals it."""
    return correlation.split("/", 1)[1]


async def _await_takeover(watcher: BenchWatcher, timeout: float) -> dict[str, str]:
    """The record a controller writes when another takes its connection."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        record = watcher.taken_over()
        if record is not None:
            return record
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"no controller stood down within {timeout}s of a second one starting for "
        "the same agent, so either both are connected or neither is"
    )


async def _connection_counts(
    bench: BenchServer, agent_id: str, seconds: float
) -> tuple[int, ...]:
    """How many connections the agent held, sampled over a settling window."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + seconds
    counts = [len(bench.connections.for_agent(agent_id))]
    while loop.time() < deadline:
        await asyncio.sleep(0.25)
        counts.append(len(bench.connections.for_agent(agent_id)))
    return tuple(counts)


async def _await_connections(
    bench: BenchServer, agent_id: str, expected: int, settling_to: str, timeout: float
) -> tuple[float, tuple[str, ...]]:
    """Seconds until the agent holds exactly `expected` connections, and which.

    `settling_to` names the one the agent is settling onto, and the count alone
    is not enough without it: two topologies meeting on one agent pass through
    the right number of the wrong connections on the way. A build being taken
    over holds its own until it is swept, so there is a moment where it is the
    only one left and the build taking over has not connected yet.
    """
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + timeout
    held: tuple[str, ...] = ()
    while loop.time() < deadline:
        held = tuple(
            connection.id for connection in bench.connections.for_agent(agent_id)
        )
        if len(held) == expected and settling_to in held:
            return loop.time() - started, held
        await asyncio.sleep(0.1)
    raise TimeoutError(
        f"agent {agent_id} held {len(held)} connection(s) rather than {expected} "
        f"including {settling_to} throughout {timeout}s: {held}"
    )


async def _await_reservation(
    bench: BenchServer, agent_id: str, settled: tuple[str, ...], timeout: float
) -> tuple[str, ...]:
    """The deliveries reserved since `settled`, once there is at least one.

    Anything already outstanding is excluded, so what this waits for is the
    delivery just posted rather than one left over from the message before it.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        outstanding = tuple(
            message_id
            for message_id in await bench.reserved_deliveries(agent_id)
            if message_id not in settled
        )
        if outstanding:
            return outstanding
        await asyncio.sleep(0.02)
    raise TimeoutError(
        f"no delivery was reserved for agent {agent_id} within {timeout}s, so a "
        "Core restarted now would not be restarted with one outstanding"
    )


async def _await_reconnection(core: BenchCore, agent_id: str, timeout: float) -> float:
    """Seconds until the agent holds an inbound connection to the new Core."""
    started = asyncio.get_running_loop().time()
    await await_stream(core.server, agent_id, timeout)
    return asyncio.get_running_loop().time() - started


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
