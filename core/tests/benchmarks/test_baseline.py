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
import os
from pathlib import Path

import pytest

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

    A room the loser was serving does not come with it. Its workers keep
    running and the winner cannot route to them, and once they are gone the
    room is held by a session only the loser could start again — the saved
    state a session is revived from lives in the controller's own directory,
    which on two machines is not a thing the winner can read at all. Messages
    addressed to that room are held by Switch and disclosed rather than lost or
    served twice, and they stay held. That is asserted here as the behaviour it
    is, beside a room the winner picks up normally, so the stranding is pinned
    to the loser's rooms rather than to the takeover.

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

                stranded = new_marker()
                markers[stranded] = await send(room_id, stranded)
                # Declined rather than delivered, while the room is held by a
                # worker the winner has no way to reach.
                assert await dispatch_wait(
                    second, {stranded: markers[stranded]}, STRANDED_SECONDS
                ) == frozenset([markers[stranded]])
                released = await _await_release(
                    second, room_id, _message_of(markers[stranded]), STRANDED_SECONDS
                )
                # Held by Switch rather than answered for: the promise the
                # winner declined is still an outstanding row, which is what a
                # delivery is finally built from.
                reserved = await bench.reserved_deliveries(target.agent_id)
                assert _message_of(markers[stranded]) in reserved, reserved

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
                # served. It is still not the winner's to serve: reviving that
                # session needs the state the loser saved, so the room stays
                # held rather than being picked up.
                orphaned = first.kill_sessions()
                lapsed = await _await_recoverable(
                    bench, target.agent_id, room_id, assigned[room_id], 120.0
                )
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
        f"the second took its connection, and stayed down. The message addressed to "
        f"the room the first was serving was declined {released} time(s) and kept as "
        f"an outstanding reservation; killing that controller's "
        f"{orphaned} worker process(es) freed the room's claim {lapsed:.1f}s later "
        "but the message is still held, because the session that holds the room can "
        "only be started again by the controller that saved it. A room the first "
        "never served was delivered to normally."
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
    the upgrade is served normally. What the room does not keep is its session.
    The controller restarts a superseded session reachable over its own
    connection but without the rooms that session was serving, so the session
    comes up holding none, its claim on the room lapses, and the next message
    there is answered by a new session that was never told what the last one
    was. That is asserted as the behaviour it is, so that fixing it fails here
    rather than passing quietly.

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
        _, legacy = await _await_connections(bench, target.agent_id, 2, 30.0)
        assert watcher.connection_id in legacy, legacy

        watcher.stop_controller()
        watcher.start_controller(bundle, controller_connection_id(target.agent_id))
        settled, current = await _await_connections(bench, target.agent_id, 1, 180.0)
        assert current == (controller_connection_id(target.agent_id),), current

        after = new_marker()
        markers[after] = await send(served_room, after)
        assert not await dispatch_wait(
            watcher, {after: markers[after]}, dispatch_timeout(1)
        )
        # Answered, but by a session started for this message rather than by
        # the one that had been serving the room since before the upgrade.
        replacing = watcher.sessions_by_room()[served_room]
        assert replacing != assigned[served_room]

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
        "The room the older build had been serving did not keep its session: the "
        f"upgrade restarted {assigned[served_room]} without the rooms it held, so "
        f"the next message there was answered by {replacing}, which was started "
        "for that message and knows nothing of the conversation before it."
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
        settled, current = await _await_connections(bench, target.agent_id, 1, 180.0)
        assert current == (connection,), current

        after = new_marker()
        markers[after] = await send(served_room, after)
        assert not await dispatch_wait(
            watcher, {after: markers[after]}, dispatch_timeout(1)
        )
        serving = watcher.sessions_by_room()[served_room]
        assert serving == assigned[served_room], (serving, assigned[served_room])

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
        f"session that had been serving it, {serving}, so its next message was "
        "answered with the conversation behind it. Every message was delivered "
        "once, and a room first addressed after the upgrade was served normally."
    )
    assert duplicated == {}, duplicated


def _message_of(correlation: str) -> str:
    """The message id half of a correlation, as the watcher journals it."""
    return correlation.split("/", 1)[1]


async def _await_release(
    watcher: BenchWatcher, room_id: str, message_id: str, timeout: float
) -> int:
    """How many times this controller handed one delivery back, once it has.

    Polled rather than read once: the controller writes the journal record
    after it has told Switch, so the log line saying it declined the delivery
    is there before the record proving it did.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        handed_back = watcher.releases().count((room_id, message_id))
        if handed_back:
            return handed_back
        await asyncio.sleep(0.1)
    raise TimeoutError(
        f"the controller neither delivered message {message_id} nor recorded "
        f"handing it back within {timeout}s, so what became of it is unaccounted for"
    )


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
    bench: BenchServer, agent_id: str, expected: int, timeout: float
) -> tuple[float, tuple[str, ...]]:
    """Seconds until the agent holds exactly `expected` connections, and which.

    The identities are returned rather than just the count because two
    topologies meeting on one agent is exactly the case where the right number
    of connections can be the wrong ones.
    """
    loop = asyncio.get_running_loop()
    started = loop.time()
    deadline = started + timeout
    held: tuple[str, ...] = ()
    while loop.time() < deadline:
        held = tuple(
            connection.id for connection in bench.connections.for_agent(agent_id)
        )
        if len(held) == expected:
            return loop.time() - started, held
        await asyncio.sleep(0.1)
    raise TimeoutError(
        f"agent {agent_id} held {len(held)} connection(s) rather than {expected} "
        f"throughout {timeout}s: {held}"
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
