"""Properties the benchmark harness itself must hold, or its figures are wrong.

Everything here is about the measuring instrument rather than the thing
measured, which is why it needs no server, no Postgres and no host processes,
and why it runs in the default test suite rather than behind `just bench`. A
benchmark is only worth the confidence placed in its instrument, and each of
these guards a way the instrument was found to be lying: a workload it could
not see doing work twice, an observer that stalled the server it was timing,
and a CPU total that discarded every process which exited before the end.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterable

import pytest

from tests.benchmarks import metrics
from tests.benchmarks.metrics import ProcessSample, ResourceReport, ResourceSampler
from tests.benchmarks.trace import (
    ADMISSION_RECEIVED,
    ADMISSION_RESPONDED,
    CORE_COMMIT,
    PROVIDER_DISPATCH,
    SSE_PUSH,
    TraceCollector,
)
from tests.benchmarks.workload import Posted, render, score

#: How long the faked `ps`/`lsof` pair blocks for. Far longer than the real
#: pair takes, so that a collection running on the event loop cannot fail to be
#: noticed, and so the assertion has room to be generous about scheduling noise.
FAKE_COLLECTION_SECONDS = 0.4

#: The ticker's period, and the lateness it is allowed. The gap between them is
#: what makes this a test of blocking rather than of machine speed: a loop-bound
#: collection would put the ticker `FAKE_COLLECTION_SECONDS` late, five times
#: the tolerance, so a busy machine cannot fail it and a regression cannot pass.
TICK_SECONDS = 0.001
TICK_TOLERANCE_SECONDS = 0.08


def test_a_repeated_dispatch_is_reported_rather_than_folded_away() -> None:
    """Two dispatches of one message must not score as one.

    The latency view keeps the first record per point and drops the rest, which
    is right for timing and blind to duplication. Without a separate count, a
    topology that executed a turn twice would report a clean run.
    """
    collector = TraceCollector()
    collector.record(SSE_PUSH, "room/a")
    collector.record(PROVIDER_DISPATCH, "room/a", process="host:1")
    collector.record(PROVIDER_DISPATCH, "room/a", process="host:2")
    collector.record(PROVIDER_DISPATCH, "room/b", process="host:1")

    assert collector.repeats(PROVIDER_DISPATCH) == {"room/a": 2}
    # The blindness the count exists to cover: the latency view cannot tell the
    # duplicated correlation from the one served exactly once.
    grouped = collector.by_correlation()
    assert set(grouped["room/a"]) == {SSE_PUSH, PROVIDER_DISPATCH}
    assert PROVIDER_DISPATCH in grouped["room/b"]


def test_a_point_seen_once_everywhere_reports_no_repeats() -> None:
    """The clean case must be empty, not merely small."""
    collector = TraceCollector()
    for correlation in ("room/a", "room/b", "room/c"):
        collector.record(PROVIDER_DISPATCH, correlation, process="host:1")
    assert collector.repeats(PROVIDER_DISPATCH) == {}


def _served(collector: TraceCollector, correlation: str, *, host: str) -> None:
    """Record every point of one message's journey, server side then host."""
    for point in (SSE_PUSH, ADMISSION_RECEIVED, CORE_COMMIT, ADMISSION_RESPONDED):
        collector.record(point, correlation)
    collector.record(PROVIDER_DISPATCH, correlation, process=host)


def test_scoring_carries_a_duplicate_through_to_the_result_and_the_report() -> None:
    """The count is only worth having if it reaches what the tests assert on.

    Scoring, the result object and the rendered report are three places the
    figure has to survive. A break in any of them would leave the assertions in
    the baseline passing over a run that duplicated work, which is the exact
    silence this whole finding was about.
    """
    collector = TraceCollector()
    _served(collector, "room/a", host="host:1")
    _served(collector, "room/b", host="host:1")
    # The same message handed to a provider a second time, by a second host.
    collector.record(PROVIDER_DISPATCH, "room/a", process="host:2")

    result = score(
        label="duplication",
        rooms=2,
        collector=collector,
        posted=Posted(
            markers={"m-a": "room/a", "m-b": "room/b"}, cold=frozenset({"room/a"})
        ),
        undelivered=frozenset(),
        resources=ResourceReport(
            label="duplication",
            wall_seconds=1.0,
            samples=2,
            peak_process_count=3,
            peak_rss_kib=1024,
            peak_connections=2,
            peak_streams=2,
            cpu_seconds=0.5,
        ),
    )

    assert result.duplicated == (("room/a", 2),)
    assert result.undelivered == ()
    rendered = render([result])
    assert "SERVED TWICE" in rendered
    assert "served 2x: room/a" in rendered


def test_scoring_reports_no_duplicates_when_every_message_was_served_once() -> None:
    """The figure must be empty on a clean run, so it can gate one."""
    collector = TraceCollector()
    _served(collector, "room/a", host="host:1")
    _served(collector, "room/b", host="host:1")

    result = score(
        label="clean",
        rooms=2,
        collector=collector,
        posted=Posted(
            markers={"m-a": "room/a", "m-b": "room/b"}, cold=frozenset({"room/a"})
        ),
        undelivered=frozenset(),
        resources=ResourceReport(
            label="clean",
            wall_seconds=1.0,
            samples=2,
            peak_process_count=3,
            peak_rss_kib=1024,
            peak_connections=2,
            peak_streams=2,
            cpu_seconds=0.5,
        ),
    )

    assert result.duplicated == ()
    assert "SERVED TWICE" not in render([result])


def _fake_slow_os(
    monkeypatch: pytest.MonkeyPatch, processes: dict[int, ProcessSample]
) -> Callable[[], int]:
    """Replace the module's subprocess calls with scripted, slow stand-ins.

    Returns a reader for how many collections have run, so a test can prove the
    sampler was actually working rather than passing because it did nothing.
    """
    collections = 0

    def descendants(root_pid: int) -> list[int]:
        return [root_pid, *processes]

    def sample_processes(pids: Iterable[int]) -> dict[int, ProcessSample]:
        nonlocal collections
        collections += 1
        # Blocking on purpose, and blocking the way the real thing does: with
        # `time.sleep`, which no event loop can interleave around.
        time.sleep(FAKE_COLLECTION_SECONDS)
        return dict(processes)

    def established_connections(port: int) -> int:
        return 0

    monkeypatch.setattr(metrics, "descendants", descendants)
    monkeypatch.setattr(metrics, "sample_processes", sample_processes)
    monkeypatch.setattr(metrics, "established_connections", established_connections)
    return lambda: collections


async def test_sampling_does_not_stall_the_loop_the_server_runs_on(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The observer must not be charged to the thing observed.

    The Switch server under measurement shares this event loop, so a `ps` or
    `lsof` run on it suspends request handling for the length of the scan — and
    the scan gets more expensive as the topology grows more processes, so the
    arrangement penalises exactly the revision the benchmark exists to compare
    against. The sample therefore has to happen in a thread, and this asserts it
    does by watching whether a timer on the loop keeps its schedule while a
    deliberately slow collection is in progress.
    """
    taken = _fake_slow_os(monkeypatch, {4242: ProcessSample(4242, 1024, 0.0, "worker")})
    sampler = ResourceSampler(
        root_pids=[1],
        port=0,
        count_streams=lambda: 0,
        interval_seconds=0.01,
    )

    loop = asyncio.get_running_loop()
    worst_lateness = 0.0

    async def ticker() -> None:
        nonlocal worst_lateness
        while True:
            started = loop.time()
            await asyncio.sleep(TICK_SECONDS)
            worst_lateness = max(worst_lateness, loop.time() - started - TICK_SECONDS)

    beating = asyncio.create_task(ticker())
    try:
        async with sampler.running("loop responsiveness"):
            await asyncio.sleep(FAKE_COLLECTION_SECONDS * 2.5)
    finally:
        beating.cancel()

    # Without this the test would pass on a sampler that never sampled.
    assert taken() >= 2, f"only {taken()} collection(s) ran; nothing was proven"
    assert worst_lateness < TICK_TOLERANCE_SECONDS, (
        f"a loop timer ran {worst_lateness * 1000:.1f} ms late while the sampler "
        f"collected, against a {FAKE_COLLECTION_SECONDS * 1000:.0f} ms collection. "
        "The OS scan is back on the event loop, and its cost is being added to "
        "every latency this harness reports."
    )


async def test_cpu_is_counted_for_a_process_that_exits_before_the_run_ends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A host that dies mid-run still consumed what it consumed.

    Totalling only the processes alive at the final sample reports zero for the
    recovery case's killed host and for every host that failed and was replaced,
    so a topology that churned more would be scored as costing less.
    """
    live: dict[int, ProcessSample] = {}
    monkeypatch.setattr(metrics, "descendants", lambda root: [root, *live])
    monkeypatch.setattr(metrics, "sample_processes", lambda pids: dict(live))
    monkeypatch.setattr(metrics, "established_connections", lambda port: 0)

    sampler = ResourceSampler(
        root_pids=[1],
        port=0,
        count_streams=lambda: 0,
        interval_seconds=60.0,
    )

    live = {4242: ProcessSample(4242, 2048, 0.0, "worker")}
    await sampler.sample()
    live = {4242: ProcessSample(4242, 2048, 1.0, "worker")}
    await sampler.sample()
    # Killed, as the recovery case kills one.
    live = {}
    await sampler.sample()

    report = sampler.report("one host killed", wall_seconds=3.0)
    assert report.cpu_seconds == pytest.approx(1.0)
    assert report.peak_process_count == 1
    assert report.peak_rss_kib == 2048


async def test_cpu_already_burned_before_the_run_is_not_charged_to_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The driver has a long history; the workload did not cause it.

    A process present at the first sample is baselined against what it had
    already used, while one that appears later is charged in full, because
    everything it has ever used it used for this workload.
    """
    live: dict[int, ProcessSample] = {1: ProcessSample(1, 512, 100.0, "driver")}
    monkeypatch.setattr(metrics, "descendants", lambda root: list(live))
    monkeypatch.setattr(metrics, "sample_processes", lambda pids: dict(live))
    monkeypatch.setattr(metrics, "established_connections", lambda port: 0)

    sampler = ResourceSampler(
        root_pids=[1],
        port=0,
        count_streams=lambda: 0,
        interval_seconds=60.0,
    )
    await sampler.sample()
    live = {
        1: ProcessSample(1, 512, 102.5, "driver"),
        4242: ProcessSample(4242, 512, 0.5, "worker"),
    }
    await sampler.sample()

    # 2.5s of driver time during the run, and the whole 0.5s of the worker that
    # only exists because of it. The driver's prior 100s is not the workload's.
    assert sampler.report("mixed", wall_seconds=2.0).cpu_seconds == pytest.approx(3.0)


async def test_a_reused_pid_does_not_erase_the_cpu_of_the_process_before_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cumulative counter that falls means a new process, not negative work."""
    live: dict[int, ProcessSample] = {}
    monkeypatch.setattr(metrics, "descendants", lambda root: [root, *live])
    monkeypatch.setattr(metrics, "sample_processes", lambda pids: dict(live))
    monkeypatch.setattr(metrics, "established_connections", lambda port: 0)

    sampler = ResourceSampler(
        root_pids=[1],
        port=0,
        count_streams=lambda: 0,
        interval_seconds=60.0,
    )
    # Nothing at the first sample, so both of the processes below appeared
    # during the run and all of their CPU belongs to it.
    await sampler.sample()
    live = {4242: ProcessSample(4242, 512, 3.0, "worker")}
    await sampler.sample()
    # Same pid, counter reset: the kernel handed 4242 to something else.
    live = {4242: ProcessSample(4242, 512, 0.25, "replacement")}
    await sampler.sample()

    assert sampler.report("pid reuse", wall_seconds=3.0).cpu_seconds == pytest.approx(
        3.25
    )


def test_a_sampler_that_never_ran_refuses_to_report() -> None:
    """Zero resource usage and unmeasured resource usage are not the same."""
    sampler = ResourceSampler(
        root_pids=[1], port=0, count_streams=lambda: 0, interval_seconds=1.0
    )
    with pytest.raises(ValueError, match="never run"):
        sampler.report("nothing happened", wall_seconds=1.0)
