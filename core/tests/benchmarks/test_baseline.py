"""The end-to-end measurement of an agent's sessions on Switch.

These are not pass/fail tests in the usual sense. Almost nothing here asserts a
threshold, because there is no agreed one to assert: the deliverable is a set
of figures for the topology. What *is* asserted is that the run happened as
the product promises: every message reached a provider exactly once, the
session answered it through its own Switch tools into the room it was asked
in, and its turn was reported for messaging platforms to draw. A benchmark
that quietly measured half its workload, or the first of two executions of the
same work, would report a flattering number rather than a failure.

The topology under measurement: one watcher per agent holds the agent's only
connection, owns the room → session map (`placements.json`, stated to Switch
after every change and on every reconnect) and makes every Switch call. Each
session host is its child, talks to it over an IPC pipe, and serves the Switch
MCP tools to its provider on loopback; the provider answers by calling
`post_message` there. The headline figure is still the peak number of agent
protocol connections one agent holds: one, whatever the session count.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

import pytest

from tests.benchmarks.host import (
    BenchWatcher,
    alive,
    bench_watcher,
    build_bench_bundle,
    controller_connection_id,
    dispatched,
    host_records,
    marked,
    new_marker,
    successor_bundle,
)
from tests.benchmarks.metrics import ResourceReport, sample_processes
from tests.benchmarks.server import BenchAgent, BenchCore, BenchServer
from tests.benchmarks.trace import (
    APPROVAL_APPLIED,
    APPROVAL_OPENED,
    PROVIDER_DISPATCH,
    REPLY_ACCEPTED,
    ROOM_CONNECTED,
    SSE_PUSH,
    TraceCollector,
    correlation_for,
)
from tests.benchmarks.workload import (
    STREAM_TIMEOUT_SECONDS,
    Posted,
    WorkloadResult,
    answer_wait,
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
#: fifty is past the point where a per-session cost dominates.
SCALES = (1, 10, 50)

#: Messages per room. More than one so a session's *second* message — served by
#: an already-running host rather than a cold start — is in the population.
MESSAGES_PER_ROOM = 3

#: How long a delivery a controller cannot make is watched before it is called
#: held rather than merely slow. Several times the watcher's five second
#: ownership retry, so a delivery it would pick up on a later pass is not read
#: as one it refused.
STRANDED_SECONDS = 20.0

#: How many times two sessions are raced into the same room. The ordering
#: inside the watcher and the server is not staged, so the property is held
#: over repeated attempts rather than demonstrated once.
ROOM_MOVE_ROUNDS = 3

#: How long a population of served, idle sessions is watched for the requests
#: it makes anyway.
IDLE_SECONDS = 30.0

#: The idle time after which a session host parks, for the parking scenario.
#: Short enough to wait out, long enough that a turn and its reports finish.
PARK_AFTER_MS = 3000

#: How long a parked session or a stopped controller is watched to see that
#: nothing starts it before it is needed.
STAYS_PARKED_SECONDS = 5.0

#: Nothing added to a watcher's environment.
NO_ENVIRONMENT: Mapping[str, str] = {}


@pytest.fixture(scope="session")
def bundle() -> Path:
    return build_bench_bundle()


async def _agents(bench: BenchServer, slug: str) -> tuple[BenchAgent, BenchAgent]:
    """The agent being measured and one to address it from, both started."""
    target = await bench.register_agent(f"bench-target-{slug}")
    poster = await bench.register_agent(f"bench-poster-{slug}")
    await bench.start_clients(timeout=60.0)
    return target, poster


async def _rooms(
    bench: BenchServer, slug: str, count: int, members: list[BenchAgent]
) -> list[str]:
    return [
        await bench.create_room(
            f"bench-{slug}-{index}", [member.agent_id for member in members]
        )
        for index in range(count)
    ]


def _watch(
    bench: BenchServer,
    target: BenchAgent,
    bundle: Path,
    home: Path,
    environment: Mapping[str, str],
):
    home.mkdir(parents=True)
    return bench_watcher(
        bundle=bundle,
        home=home,
        base_url=bench.base_url,
        agent_id=target.agent_id,
        api_key=target.api_key,
        environment=environment,
    )


async def _send(
    bench: BenchServer,
    poster: BenchAgent,
    target: BenchAgent,
    room_id: str,
    marker: str,
    instructions: str,
) -> str:
    """Address a marked message into a room, returning its correlation.

    `instructions` is the rest of the body, which the scripted provider reads:
    empty for a plain answer.
    """
    message_id = await bench.address(
        sender=poster,
        room_id=room_id,
        target=target.name,
        body=f"@{target.name} {marked(marker)} {instructions}".rstrip(),
    )
    return correlation_for(room_id, message_id)


async def _answered(
    watcher: BenchWatcher,
    collector: TraceCollector,
    markers: dict[str, str],
    timeout: float,
) -> None:
    """Every marker dispatched to a provider and answered, or fail saying which."""
    assert not await dispatch_wait(watcher, markers, timeout), (
        watcher.failure() or "not dispatched"
    )
    unanswered = await answer_wait(collector, frozenset(markers.values()), timeout)
    assert not unanswered, (unanswered, watcher.failure())


async def _placements_agree(
    bench: BenchServer, watcher: BenchWatcher, agent_id: str, timeout: float
) -> dict[str, str]:
    """Switch holds the placements the watcher holds, within `timeout`.

    The watcher states them after every change and on every reconnect, and
    `post_message` goes to the room Switch has the calling session in, so a
    disagreement is a reply posted somewhere the room's session is not.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        local = watcher.sessions_by_room()
        held = bench.placed_sessions(agent_id, list(local))
        stray = {
            session: room
            for session, room in bench.connections.placements(agent_id).items()
            if local.get(room) != session
        }
        if held == local and not stray:
            return local
        if loop.time() >= deadline:
            raise AssertionError(
                f"Switch places {held} (and {stray} the watcher does not) while "
                f"the watcher places {local}"
            )
        await asyncio.sleep(0.05)


async def _await_host_point(
    watcher: BenchWatcher, point: str, markers: Mapping[str, str], timeout: float
) -> dict[str, dict]:
    """The first record at `point` for each marker, waiting up to `timeout`."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        found: dict[str, dict] = {}
        for record in host_records(watcher, point):
            found.setdefault(record["correlation"], record)
        if all(marker in found for marker in markers):
            return {marker: found[marker] for marker in markers}
        if loop.time() >= deadline:
            raise TimeoutError(
                f"{point} was never traced for "
                f"{sorted(set(markers) - set(found))}: {watcher.failure()}"
            )
        await asyncio.sleep(0.05)


def _assert_clean(result: WorkloadResult) -> None:
    assert result.unmeasured == (), result.unmeasured
    assert result.undelivered == (), result.undelivered
    assert result.unanswered == (), result.unanswered
    assert result.duplicated == (), result.duplicated
    assert result.replied_twice == (), result.replied_twice
    assert result.misplaced == (), result.misplaced


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
    `label` is the prose the report is headed with.
    """
    target, poster = await _agents(bench, slug)
    room_ids = await _rooms(bench, slug, rooms, [target, poster])
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        result = await run_workload(
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
        placed = await _placements_agree(bench, watcher, target.agent_id, 10.0)
        assert set(placed) == set(room_ids), placed
        assert len(set(placed.values())) == rooms, placed
        assert watcher.failure() is None, watcher.failure()
    return result


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
        _assert_clean(result)
        assert result.messages == result.rooms * MESSAGES_PER_ROOM
        # The one connection the agent's watcher holds, whatever the session
        # count — the deliverable, so an equality rather than a bound.
        assert result.resources.peak_streams == 1, result.resources


async def test_baseline_idles_at_session_count(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """What 1, 10 and 50 served sessions ask of the server while nothing happens.

    Each room is sent one message so that its session exists, has answered and
    is idle, and the server is then watched for `IDLE_SECONDS` with nothing
    addressed to anyone. Every request it is sent in that window is counted by
    route, beside the statements it sends its database and the CPU the driver
    process (which hosts the server) and the agent's process tree used. After
    the window one more message is addressed, so a quieter idle is seen not to
    have cost the next answer its latency.
    """
    lines: list[str] = []
    for rooms in SCALES:
        target, poster = await _agents(bench, f"idle-{rooms}")
        room_ids = await _rooms(bench, f"idle-{rooms}", rooms, [target, poster])
        home = tmp_path / f"home-idle-{rooms}"
        with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
            await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
            markers: dict[str, str] = {}
            for room in room_ids:
                marker = new_marker()
                markers[marker] = await _send(bench, poster, target, room, marker, "")
            await _answered(watcher, collector, markers, dispatch_timeout(rooms))
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
            markers[addressed] = await _send(
                bench, poster, target, room_ids[0], addressed, ""
            )
            sent = clock.time()
            await _answered(
                watcher, collector, {addressed: markers[addressed]}, dispatch_timeout(1)
            )
            latency = clock.time() - sent
            assert watcher.failure() is None, watcher.failure()
            collector.ingest_jsonl(watcher.trace_path, markers)

        routes = ", ".join(
            f"{route} {count}" for route, count in sorted(requests.items())
        )
        reports = sum(
            count
            for route, count in requests.items()
            if route.startswith("agent-sessions")
        )
        lines.append(
            f"{rooms} idle session(s) over {watched:.1f}s: "
            f"watcher heartbeats {requests['agents/connection/beat']}, "
            f"session host requests {reports}, "
            f"all requests {sum(requests.values())} ({routes}); "
            f"{statements} database statements; CPU driver "
            f"{cpu(pids[:1]):.2f}s, agent processes {cpu(pids[1:]):.2f}s; "
            f"next addressed message answered in {latency:.2f}s"
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
    # Arriving together must neither cost a message nor serve one twice: it is
    # the case where two sessions could race for the same room.
    _assert_clean(result)
    assert result.resources.peak_streams == 1, result.resources


async def test_baseline_relays_an_approval(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session asks a person before answering, and the answer reaches it.

    The provider opens a request; the host reports it to Switch; a person
    answers it there; Switch pushes the outcome down the watcher's stream; the
    watcher wakes the session; the host reads the outcome, hands the decision
    to the provider, and acknowledges it. Only then does the provider answer
    the room. Nothing but the answer may unblock it.
    """
    target, poster = await _agents(bench, "approval")
    (room_id,) = await _rooms(bench, "approval", 1, [target, poster])
    home = tmp_path / "home-approval"
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, approval relayed"):
            warm = new_marker()
            markers = {warm: await _send(bench, poster, target, room_id, warm, "")}
            await _answered(watcher, collector, markers, dispatch_timeout(1))

            asked = new_marker()
            markers[asked] = await _send(
                bench, poster, target, room_id, asked, "switch-bench-approve"
            )
            await _await_host_point(
                watcher, "approval_requested", {asked: markers[asked]}, 30.0
            )
            request = await _open_request(bench, target.agent_id, 30.0)
            # Held on the person: a provider that answered without the
            # decision would already have posted by the time the request was
            # stored and read back.
            await asyncio.sleep(2.0)
            assert REPLY_ACCEPTED not in collector.by_correlation().get(
                markers[asked], {}
            )
            answered_at = asyncio.get_running_loop().time()
            await bench.answer_approval(request, "accept")
            await _answered(
                watcher, collector, {asked: markers[asked]}, dispatch_timeout(1)
            )
            relayed = asyncio.get_running_loop().time() - answered_at
            settled = await _settled_request(
                bench, target.agent_id, request.request_id, 30.0
            )
        collector.ingest_jsonl(watcher.trace_path, markers)
        applied = host_records(watcher, APPROVAL_APPLIED)
        assert [record["detail"]["decision"] for record in applied] == ["accept"]
        assert watcher.failure() is None, watcher.failure()

    rows = await bench.activity_rows(target.agent_id)
    asked_turns = [
        row
        for row in rows
        if row.kind == "turn" and row.message_id == markers[asked].split("/", 1)[1]
    ]
    assert [row.status for row in asked_turns] == ["completed"], asked_turns
    tools = {
        row.title
        for row in rows
        if row.kind == "tool-activity" and row.turn_id == asked_turns[0].turn_id
    }
    assert tools == {"post_message"}, tools
    assert APPROVAL_OPENED in collector.by_correlation()[markers[asked]]
    result = score(
        label="1 session, approval relayed",
        rooms=1,
        collector=collector,
        posted=Posted(
            markers=markers, cold=frozenset([markers[warm]]), cut=frozenset()
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-approval.md"))
    print(
        f"approval: the request was stored as {settled.state} by {settled.answered_by} "
        f"and acknowledged by the host; the session answered the room {relayed:.2f}s "
        "after the person did"
    )
    _assert_clean(result)
    assert settled.state == "answered"
    assert settled.delivered_at is not None


async def test_baseline_recovers_from_a_lost_host(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session host is killed outright; its room's messages must flow again.

    Its parent, the watcher, survives: it sees the host exit, starts it again
    from its saved state, and hands it what it had not acknowledged. The room
    keeps its session and the session its provider conversation.

    Two messages are exposed: one posted immediately before the kill, which may
    be anywhere between the watcher and the provider when the host dies, and
    one posted while there is no host. Both must be dispatched at most once,
    and the second must be answered.
    """
    target, poster = await _agents(bench, "recovery")
    (room_id,) = await _rooms(bench, "recovery", 1, [target, poster])
    home = tmp_path / "home-recovery"
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, host killed mid-run"):
            before = new_marker()
            markers = {before: await _send(bench, poster, target, room_id, before, "")}
            await _answered(watcher, collector, markers, dispatch_timeout(1))
            session = watcher.sessions_by_room()[room_id]

            in_flight = new_marker()
            markers[in_flight] = await _send(
                bench, poster, target, room_id, in_flight, ""
            )
            killed = watcher.kill_session(session)
            interrupted = in_flight not in dispatched(watcher, markers)

            after = new_marker()
            markers[after] = await _send(bench, poster, target, room_id, after, "")
            await _answered(
                watcher, collector, {after: markers[after]}, dispatch_timeout(2)
            )
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
            assert watcher.sessions_by_room()[room_id] == session
            assert watcher.session_pid(session) not in (None, killed)
            conversations = watcher.provider_conversations(session)
            assert len(set(conversations)) == 1, conversations
            await _placements_agree(bench, watcher, target.agent_id, 10.0)
            assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, host killed mid-run",
        rooms=1,
        collector=collector,
        # The first message starts the session, and the last starts it again.
        posted=Posted(
            markers=markers,
            cold=frozenset([markers[before], markers[after]]),
            cut=frozenset([markers[in_flight]]),
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-recovery.md"))
    print(
        f"lost host: session host {killed} was killed outright with the message "
        f"posted before the kill {'still in flight' if interrupted else 'already dispatched'}; "
        "the watcher started the same session again on the same provider "
        "conversation, and the message posted while it was down was answered once"
    )
    _assert_clean(result)
    # Starting the session again must not open a second connection.
    assert result.resources.peak_streams == 1, result.resources


async def test_baseline_recovers_from_a_lost_worker(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """The watcher process dies; its supervisor brings it straight back.

    The session hosts are the watcher's children and end with it. What comes
    back is the watcher, from its journal and `placements.json`, and it starts
    the sessions it had placed and resumes its stream from the cursor it saved.
    So a message posted just before the kill and one posted while nothing was
    listening for the agent are both dispatched exactly once, on the session
    and provider conversation the room had.
    """
    target, poster = await _agents(bench, "worker")
    (room_id,) = await _rooms(bench, "worker", 1, [target, poster])
    home = tmp_path / "home-worker"
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, watcher killed mid-run"):
            cold = new_marker()
            markers = {cold: await _send(bench, poster, target, room_id, cold, "")}
            await _answered(watcher, collector, markers, dispatch_timeout(1))
            session = watcher.sessions_by_room()[room_id]
            hosts = watcher.session_pids()

            in_flight = new_marker()
            markers[in_flight] = await _send(
                bench, poster, target, room_id, in_flight, ""
            )
            killed = watcher.kill_worker()
            interrupted = in_flight not in dispatched(watcher, markers)
            await asyncio.to_thread(watcher.await_sessions_gone, hosts, 15.0)

            orphaned = new_marker()
            markers[orphaned] = await _send(
                bench, poster, target, room_id, orphaned, ""
            )
            await _answered(
                watcher, collector, {orphaned: markers[orphaned]}, dispatch_timeout(2)
            )
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
            assert watcher.worker_pid() not in (None, killed)
            assert watcher.sessions_by_room()[room_id] == session
            conversations = watcher.provider_conversations(session)
            assert len(set(conversations)) == 1, conversations
            assert len(bench.connections.for_agent(target.agent_id)) == 1
            await _placements_agree(bench, watcher, target.agent_id, 10.0)
            assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, watcher killed mid-run",
        rooms=1,
        collector=collector,
        posted=Posted(
            markers=markers,
            cold=frozenset([markers[cold], markers[orphaned]]),
            cut=frozenset([markers[in_flight]]),
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-worker.md"))
    print(
        f"lost worker: watcher process {killed} was killed under a supervisor that "
        f"survived, with the message posted before the kill "
        f"{'still in flight' if interrupted else 'already dispatched'}; its "
        f"{len(hosts)} session host(s) ended with it, and the watcher that came back "
        f"answered the message posted while it was down on the same session "
        f"({session}) and provider conversation"
    )
    _assert_clean(result)
    assert result.resources.peak_streams == 1, result.resources


async def test_baseline_survives_a_controller_restart(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """The whole controller is killed and started again with deliveries outstanding.

    This is Console being killed and reopened: supervisor and watcher go at
    once, the session hosts end when their pipe closes, and nothing else is
    listening for the agent until a controller is started again on the same
    state. It must resume from its own journal and placements — the same
    session for the room, resumed on the same conversation — and deliver both
    the message posted just before the kill and the one posted while it was
    gone, exactly once.
    """
    target, poster = await _agents(bench, "restart")
    (room_id,) = await _rooms(bench, "restart", 1, [target, poster])
    home = tmp_path / "home-restart"
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, controller restarted mid-flight"):
            cold = new_marker()
            markers = {cold: await _send(bench, poster, target, room_id, cold, "")}
            await _answered(watcher, collector, markers, dispatch_timeout(1))
            session = watcher.sessions_by_room()[room_id]

            in_flight = new_marker()
            markers[in_flight] = await _send(
                bench, poster, target, room_id, in_flight, ""
            )
            hosts = watcher.stop_controller()
            interrupted = in_flight not in dispatched(watcher, markers)
            await asyncio.to_thread(watcher.await_sessions_gone, hosts, 15.0)

            orphaned = new_marker()
            markers[orphaned] = await _send(
                bench, poster, target, room_id, orphaned, ""
            )
            watcher.start_controller(watcher.bundle)
            await _answered(
                watcher, collector, {orphaned: markers[orphaned]}, dispatch_timeout(2)
            )
            assert not await dispatch_wait(watcher, markers, dispatch_timeout(2))
            assert watcher.sessions_by_room()[room_id] == session
            conversations = watcher.provider_conversations(session)
            assert len(set(conversations)) == 1, conversations
            await _placements_agree(bench, watcher, target.agent_id, 10.0)
            assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, controller restarted mid-flight",
        rooms=1,
        collector=collector,
        posted=Posted(
            markers=markers,
            cold=frozenset([markers[cold], markers[orphaned]]),
            cut=frozenset([markers[in_flight]]),
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-controller-restart.md"))
    print(
        "controller restart: the message posted before the kill was "
        f"{'still in flight' if interrupted else 'already dispatched'} when the "
        f"controller died; its {len(hosts)} session host(s) ended when their pipe "
        "closed, and the controller started on the same state answered the "
        "message posted while there was none, once, on the same session"
    )
    _assert_clean(result)
    # One connection across the restart: the new controller reopens the one
    # derived from the agent.
    assert result.resources.peak_streams == 1, result.resources


async def test_baseline_survives_a_core_restart(
    core: BenchCore, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Switch itself is restarted while a message is on its way to a session.

    The controller and its sessions are left running and the database is kept;
    what goes is the Core and everything it held in memory, the placements
    among them. Once the watcher has routed a message to a session, the
    session's own journal holds it, so a Core that comes back with an empty
    buffer must not cost it or repeat it; and the watcher states its
    placements again on reconnecting, so the session's `post_message` lands in
    its room on the new Core too.
    """
    bench = core.server
    target, poster = await _agents(bench, "core")
    warm_room, held_room = await _rooms(bench, "core", 2, [target, poster])
    home = tmp_path / "home-core"

    async def send(room_id: str, marker: str) -> str:
        return await _send(core.server, poster, target, room_id, marker, "")

    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for_core(core, watcher, target.agent_id)
        async with sampler.running("2 sessions, Core restarted mid-delivery"):
            warm = new_marker()
            markers = {warm: await send(warm_room, warm)}
            await _answered(watcher, collector, markers, dispatch_timeout(1))
            assigned = watcher.sessions_by_room()

            held = new_marker()
            markers[held] = await send(held_room, held)
            await _await_placed(watcher, held_room, 30.0)
            emptied = bench.event_buffer

            await core.restart()
            # The buffer really is gone: a restart that inherited it would
            # prove nothing about the delivery surviving on its own.
            assert core.server.event_buffer is not emptied
            await core.server.start_clients(timeout=60.0)
            reconnected = await _await_reconnection(
                core, target.agent_id, STREAM_TIMEOUT_SECONDS
            )
            assert len(core.server.connections.for_agent(target.agent_id)) == 1
            placed = await _placements_agree(
                core.server, watcher, target.agent_id, 15.0
            )
            assert set(placed) == {warm_room, held_room}, placed

            await _answered(
                watcher, collector, {held: markers[held]}, dispatch_timeout(2)
            )
            served = watcher.sessions_by_room()
            assert served[warm_room] == assigned[warm_room]

            # The topology works after the restart, not merely through it.
            resumed = new_marker()
            markers[resumed] = await send(held_room, resumed)
            await _answered(
                watcher, collector, {resumed: markers[resumed]}, dispatch_timeout(1)
            )
            assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="2 sessions, Core restarted mid-delivery",
        rooms=2,
        collector=collector,
        posted=Posted(
            markers=markers,
            cold=frozenset([markers[warm], markers[held]]),
            cut=frozenset(),
        ),
        undelivered=frozenset(),
        replies=await core.server.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-core-restart.md"))
    print(
        "core restart: the Core was replaced once the watcher had placed a "
        f"session for a message; the agent was connected to the new one "
        f"{reconnected:.1f}s later with its placements restated, and the message "
        "was answered once, into its room"
    )
    _assert_clean(result)
    assert result.resources.peak_streams == 1, result.resources


async def test_baseline_settles_two_competing_controllers(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Two controllers are started for one agent, as two machines' Consoles would be.

    A controller's connection is derived from the agent it controls, so the
    second does not open a connection beside the first: it reopens the same
    one, and the server hands it over. The handover has to settle — the loser
    stands down durably and stays down, its session hosts end with it, the
    agent holds one connection throughout, and nothing is served twice —
    because two controllers that each reclaimed the connection from the other
    would also, at any single moment, look like one.

    The loser's placements are on the other machine and do not come with the
    connection. The winner states its own, so Switch no longer places the
    loser's session anywhere; a message to the room the loser served is
    answered by a session the winner starts, into that room.
    """
    target, poster = await _agents(bench, "compete")
    room_id, fresh_room = await _rooms(bench, "compete", 2, [target, poster])
    first_home = tmp_path / "home-compete-first"
    second_home = tmp_path / "home-compete-second"
    connection = controller_connection_id(target.agent_id)

    with _watch(bench, target, bundle, first_home, NO_ENVIRONMENT) as first:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        served = new_marker()
        markers = {served: await _send(bench, poster, target, room_id, served, "")}
        await _answered(first, collector, markers, dispatch_timeout(1))
        lost_session = first.sessions_by_room()[room_id]
        hosts = first.session_pids()
        assert len(bench.connections.for_agent(target.agent_id)) == 1

        with _watch(bench, target, bundle, second_home, NO_ENVIRONMENT) as second:
            stood_down = await _await_takeover(first, STREAM_TIMEOUT_SECONDS)
            assert stood_down["connectionId"] == connection
            assert stood_down["reason"], stood_down

            held = bench.connections.for_agent(target.agent_id)
            assert len(held) == 1, held
            assert held[0].id == connection

            # Settled, not merely handed over once: a loser that reopened the
            # connection would take it back, and the two would trade it for as
            # long as both were running.
            counts = await _connection_counts(bench, target.agent_id, 10.0)
            assert set(counts) == {1}, counts
            assert second.taken_over() is None, second.taken_over()
            assert not first.controller_running()
            await asyncio.to_thread(first.await_sessions_gone, hosts, 15.0)
            assert first.failure() is None, first.failure()
            assert bench.connections.session_room(target.agent_id, lost_session) is None

            carried = new_marker()
            markers[carried] = await _send(bench, poster, target, room_id, carried, "")
            await _answered(
                second, collector, {carried: markers[carried]}, dispatch_timeout(1)
            )
            assert await dispatch_wait(
                first, {carried: markers[carried]}, STRANDED_SECONDS
            ) == frozenset([markers[carried]])
            assert second.sessions_by_room()[room_id] != lost_session

            fresh = new_marker()
            markers[fresh] = await _send(bench, poster, target, fresh_room, fresh, "")
            await _answered(
                second, collector, {fresh: markers[fresh]}, dispatch_timeout(1)
            )
            await _placements_agree(bench, second, target.agent_id, 10.0)
            assert second.failure() is None, second.failure()
            collector.ingest_jsonl(second.trace_path, markers)
        collector.ingest_jsonl(first.trace_path, markers)

    result = score(
        label="competing controllers",
        rooms=2,
        collector=collector,
        posted=Posted(
            markers=markers, cold=frozenset(markers.values()), cut=frozenset()
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=_no_resources("competing controllers"),
    )
    print(
        f"competing controllers: the first stood down ({stood_down['reason']}) when "
        "the second took its connection, and stayed down; its session host(s) "
        "ended with it and Switch dropped its placement. The room it was serving "
        "was answered by a session the second started, and a room it never "
        "served was answered normally; nothing was served or answered twice."
    )
    assert result.duplicated == (), result.duplicated
    assert result.replied_twice == (), result.replied_twice
    assert result.misplaced == (), result.misplaced
    assert result.unanswered == (), result.unanswered


async def test_baseline_upgrades_over_its_own_running_session(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """One release replaced by the next, over a served room.

    The two builds are the same bundle at two paths, because a build identity
    is the path the daemon was started from. The successor is started over the
    running controller, as an updated Console does: it finds a supervisor
    recorded under another build and stops it — supervisor, watcher and
    session hosts — before starting its own on the same state.

    The room keeps its session and the session its conversation: continuity
    has two halves, the placement that survived the upgrade and the provider
    conversation the room is actually talking to, and both are asserted.
    """
    target, poster = await _agents(bench, "successor")
    served_room, later_room = await _rooms(bench, "successor", 2, [target, poster])
    home = tmp_path / "home-successor"
    successor = successor_bundle(bundle)

    markers: dict[str, str] = {}
    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        before = new_marker()
        markers[before] = await _send(bench, poster, target, served_room, before, "")
        await _answered(watcher, collector, markers, dispatch_timeout(1))
        session = watcher.sessions_by_room()[served_room]

        hosts = watcher.session_pids()
        superseded = watcher.supervisor_pid
        replacing = asyncio.get_running_loop().time()
        watcher.start_controller(successor)
        replaced = asyncio.get_running_loop().time() - replacing
        assert not alive(superseded)
        await asyncio.to_thread(watcher.await_sessions_gone, hosts, 15.0)

        after = new_marker()
        markers[after] = await _send(bench, poster, target, served_room, after, "")
        await _answered(
            watcher, collector, {after: markers[after]}, dispatch_timeout(1)
        )
        serving = watcher.sessions_by_room()[served_room]
        assert serving == session, (serving, session)
        conversations = watcher.provider_conversations(serving)
        assert len(set(conversations)) == 1, conversations
        # More than one start, so the identity above is a conversation that was
        # resumed rather than one that was never interrupted.
        assert len(conversations) > 1, conversations

        fresh = new_marker()
        markers[fresh] = await _send(bench, poster, target, later_room, fresh, "")
        await _answered(
            watcher, collector, {fresh: markers[fresh]}, dispatch_timeout(1)
        )
        assert watcher.failure() is None, watcher.failure()
        collector.ingest_jsonl(watcher.trace_path, markers)

    grouped = collector.by_correlation()[markers[after]]
    answered_in = (grouped[REPLY_ACCEPTED].wall_ns - grouped[SSE_PUSH].wall_ns) / 1e6
    result = score(
        label="upgrade",
        rooms=2,
        collector=collector,
        posted=Posted(
            markers=markers, cold=frozenset(markers.values()), cut=frozenset()
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=_no_resources("upgrade"),
    )
    print(
        f"upgrade between two builds: the running controller was stopped and the "
        f"successor started in {replaced:.1f}s; the next message to the served "
        f"room was answered {answered_in:.0f} ms after Switch pushed it. "
        f"The room kept its session, {serving}, which resumed the provider "
        f"conversation it already had ({conversations[0]}); a room first "
        "addressed after the upgrade was answered normally, and every message "
        "was answered once."
    )
    assert result.duplicated == (), result.duplicated
    assert result.replied_twice == (), result.replied_twice
    assert result.misplaced == (), result.misplaced
    assert result.unanswered == (), result.unanswered


async def test_baseline_settles_two_sessions_taking_one_room(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """Two sessions of one agent move into the same room at once.

    Each is told, in a message to its own room, to answer and then call
    `connect_to_room` for a third room. The calls go from each session's MCP
    server up its pipe to the watcher, which places the session locally, asks
    Switch, and states its placements. Two of them at once is where the
    watcher's map and Switch's can disagree, and where one caller can be told
    it took a room it did not get.

    Each round must end with one owner of the room, who is one of the two; the
    other session in no room; Switch placing exactly what the watcher places,
    with the room claimed on the agent's connection; and exactly one caller
    told it took the room off the other — the owner. Then a message to the
    room is answered once, by the owner, into the room.

    The loser is left in no room, so each round after the first races the last
    owner against a session started for a fresh room.
    """
    target, poster = await _agents(bench, "move")
    rooms = await _rooms(bench, "move", 2 + 2 * ROOM_MOVE_ROUNDS, [target, poster])
    starting, spares = rooms[:2], rooms[2:]
    home = tmp_path / "home-move"
    connection = controller_connection_id(target.agent_id)

    with _watch(bench, target, bundle, home, NO_ENVIRONMENT) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        markers: dict[str, str] = {}
        for room_id in starting:
            marker = new_marker()
            markers[marker] = await _send(bench, poster, target, room_id, marker, "")
        await _answered(watcher, collector, markers, dispatch_timeout(2))
        placed = watcher.sessions_by_room()
        contenders = [(room_id, placed[room_id]) for room_id in starting]
        assert len({session for _, session in contenders}) == 2, placed

        owner: str | None = None
        contested: str | None = None
        for round_number in range(ROOM_MOVE_ROUNDS):
            contested = spares.pop(0)
            moves = {new_marker(): room_id for room_id, _ in contenders}
            sent = await asyncio.gather(
                *(
                    _send(
                        bench,
                        poster,
                        target,
                        room_id,
                        marker,
                        f"switch-bench-connect:{contested}",
                    )
                    for marker, room_id in moves.items()
                )
            )
            round_markers = dict(zip(moves, sent, strict=True))
            markers.update(round_markers)
            await _answered(watcher, collector, round_markers, dispatch_timeout(2))
            connected = await _await_host_point(
                watcher, ROOM_CONNECTED, round_markers, 30.0
            )
            assert not any(
                record["detail"]["isError"] for record in connected.values()
            ), connected

            local = watcher.sessions_by_room()
            owner = local.get(contested)
            sessions = [session for _, session in contenders]
            assert owner in sessions, (round_number, owner, sessions)
            displaced = next(session for session in sessions if session != owner)
            assert displaced not in local.values(), (round_number, local)
            assert bench.placed_sessions(target.agent_id, list(local)) == local
            assert bench.connections.session_room(target.agent_id, displaced) is None
            claimed = bench.connections.claimant_of(target.agent_id, contested)
            assert claimed is not None and claimed.id == connection, claimed

            warned = [
                record["detail"]
                for record in connected.values()
                if record["detail"]["warning"] is not None
            ]
            assert len(warned) == 1, [record["detail"] for record in connected.values()]
            assert warned[0]["sessionId"] == owner, warned[0]
            assert displaced in warned[0]["warning"], warned[0]

            if round_number + 1 < ROOM_MOVE_ROUNDS:
                # A fresh room, so a new session is started to race the owner.
                fresh_room = spares.pop(0)
                fresh = new_marker()
                markers[fresh] = await _send(
                    bench, poster, target, fresh_room, fresh, ""
                )
                await _answered(
                    watcher, collector, {fresh: markers[fresh]}, dispatch_timeout(1)
                )
                contenders = [
                    (contested, owner),
                    (fresh_room, watcher.sessions_by_room()[fresh_room]),
                ]

        assert owner is not None and contested is not None
        after = new_marker()
        markers[after] = await _send(bench, poster, target, contested, after, "")
        await _answered(
            watcher, collector, {after: markers[after]}, dispatch_timeout(1)
        )
        (dispatch,) = [
            record
            for record in host_records(watcher, PROVIDER_DISPATCH)
            if record["correlation"] == after
        ]
        # Served by the session that took the room: the watcher routes by
        # its map, not by which session it first started for the room.
        assert dispatch["detail"]["sessionId"] == owner, dispatch
        assert watcher.failure() is None, watcher.failure()
        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="two sessions taking one room",
        rooms=len(rooms),
        collector=collector,
        posted=Posted(markers=markers, cold=frozenset(), cut=frozenset()),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=_no_resources("two sessions taking one room"),
    )
    print(
        f"two sessions taking one room: {ROOM_MOVE_ROUNDS} rounds of two sessions "
        "of one agent calling connect_to_room for the same room at once, through "
        "their own MCP servers. Every round left the room with one owner, the "
        "other session in no room, Switch placing exactly what the watcher "
        "placed, and exactly one caller — the owner — told it had taken the room. "
        f"The message posted afterwards was answered once by {owner}, into the room."
    )
    assert result.duplicated == (), result.duplicated
    assert result.replied_twice == (), result.replied_twice
    assert result.misplaced == (), result.misplaced
    assert result.unanswered == (), result.unanswered


async def test_baseline_parks_idle_sessions_and_restarts_them_on_demand(
    bench: BenchServer, collector: TraceCollector, bundle: Path, tmp_path: Path
) -> None:
    """A session with nothing to do parks; the next message starts it again.

    With a short park timeout the session host records `parked` and exits once
    its turn is done. The room keeps its session — in the watcher's map and in
    Switch's — so the next message relaunches that same session, on the same
    provider conversation. A controller started while the session is parked
    does not start it; the message after that does.
    """
    target, poster = await _agents(bench, "park")
    (room_id,) = await _rooms(bench, "park", 1, [target, poster])
    home = tmp_path / "home-park"
    parking = {"SWITCH_SESSION_PARK_AFTER_MS": str(PARK_AFTER_MS)}
    with _watch(bench, target, bundle, home, parking) as watcher:
        await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
        sampler = sampler_for(bench, watcher, target.agent_id)
        async with sampler.running("1 session, parked and restarted on demand"):
            first = new_marker()
            markers = {first: await _send(bench, poster, target, room_id, first, "")}
            await _answered(watcher, collector, markers, dispatch_timeout(1))
            session = watcher.sessions_by_room()[room_id]
            host = watcher.session_pid(session)
            parked_after = await _await_parked(watcher, session, 60.0)
            assert host is not None and host not in watcher.session_pids()
            await _placements_agree(bench, watcher, target.agent_id, 10.0)
            assert bench.placed_sessions(target.agent_id, [room_id]) == {
                room_id: session
            }

            woken = new_marker()
            markers[woken] = await _send(bench, poster, target, room_id, woken, "")
            await _answered(
                watcher, collector, {woken: markers[woken]}, dispatch_timeout(1)
            )
            assert watcher.sessions_by_room()[room_id] == session
            assert watcher.session_pid(session) not in (None, host)

            await _await_parked(watcher, session, 60.0)
            hosts = watcher.stop_controller()
            assert hosts == set(), hosts
            watcher.start_controller(watcher.bundle)
            await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
            await asyncio.sleep(STAYS_PARKED_SECONDS)
            # The controller that came back left the parked session alone.
            assert watcher.session_pid(session) is None
            assert watcher.parked(session)

            restarted = new_marker()
            markers[restarted] = await _send(
                bench, poster, target, room_id, restarted, ""
            )
            await _answered(
                watcher,
                collector,
                {restarted: markers[restarted]},
                dispatch_timeout(1),
            )
            assert watcher.sessions_by_room()[room_id] == session
            conversations = watcher.provider_conversations(session)
            assert len(set(conversations)) == 1, conversations
            assert watcher.failure() is None, watcher.failure()

        collector.ingest_jsonl(watcher.trace_path, markers)

    result = score(
        label="1 session, parked and restarted on demand",
        rooms=1,
        collector=collector,
        # Every message finds no host running: the first because none was
        # started, the others because it had parked.
        posted=Posted(
            markers=markers, cold=frozenset(markers.values()), cut=frozenset()
        ),
        undelivered=frozenset(),
        replies=await bench.replies(),
        resources=sampler.last_report,
    )
    print("\n" + publish([result], tmp_path / "baseline-park.md"))
    grouped = collector.by_correlation()
    woke_in = (
        grouped[markers[woken]][PROVIDER_DISPATCH].wall_ns
        - grouped[markers[woken]][SSE_PUSH].wall_ns
    ) / 1e6
    print(
        f"parking: the session parked {parked_after:.1f}s after its answer "
        f"(park timeout {PARK_AFTER_MS / 1000:.0f}s); the next message started it "
        f"again and reached its provider {woke_in:.0f} ms after Switch pushed it, "
        "on the same session and conversation. A controller restarted while it "
        "was parked left it parked until the next message."
    )
    _assert_clean(result)
    assert result.resources.peak_streams == 1, result.resources


async def _open_request(bench: BenchServer, agent_id: str, timeout: float):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        requests = [
            request
            for request in await bench.approval_requests(agent_id)
            if request.state == "open"
        ]
        if requests:
            (request,) = requests
            return request
        if loop.time() >= deadline:
            raise TimeoutError(f"agent {agent_id} opened no request within {timeout}s")
        await asyncio.sleep(0.1)


async def _settled_request(
    bench: BenchServer, agent_id: str, request_id: str, timeout: float
):
    """The request once its host has acknowledged the answer."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        (request,) = [
            request
            for request in await bench.approval_requests(agent_id)
            if request.request_id == request_id
        ]
        if request.delivered_at is not None or loop.time() >= deadline:
            return request
        await asyncio.sleep(0.1)


async def _await_parked(watcher: BenchWatcher, session: str, timeout: float) -> float:
    """Seconds until the session's host has parked and exited."""
    loop = asyncio.get_running_loop()
    started = loop.time()
    while not (watcher.parked(session) and watcher.session_pid(session) is None):
        if loop.time() - started >= timeout:
            raise TimeoutError(f"session {session} did not park within {timeout}s")
        await asyncio.sleep(0.1)
    return loop.time() - started


async def _await_placed(watcher: BenchWatcher, room_id: str, timeout: float) -> None:
    """Until the watcher has placed a session in the room."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while room_id not in watcher.sessions_by_room():
        if loop.time() >= deadline:
            raise TimeoutError(f"the watcher placed nothing in {room_id} in {timeout}s")
        await asyncio.sleep(0.02)


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


async def _await_reconnection(core: BenchCore, agent_id: str, timeout: float) -> float:
    """Seconds until the agent holds an inbound connection to the new Core."""
    started = asyncio.get_running_loop().time()
    await await_stream(core.server, agent_id, timeout)
    return asyncio.get_running_loop().time() - started


def _no_resources(label: str) -> ResourceReport:
    """For a scenario whose figure is correctness rather than cost."""
    return ResourceReport(
        label=label,
        wall_seconds=0.0,
        samples=0,
        peak_process_count=0,
        peak_rss_kib=0,
        peak_connections=0,
        peak_streams=0,
        cpu_seconds=0.0,
    )
