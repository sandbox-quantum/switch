"""One benchmark workload: post, wait, and score what it cost.

A workload is a room count, a message count and a way of posting. Everything
else — the server, the host topology, the instrumentation — is identical
between them, so the difference between two workloads' figures is the
difference between the loads.

The two latency measures are kept apart deliberately, and must stay apart.

`sse push → admission received`
    The round trip a host makes to claim a room message.
`core commit → provider dispatch`
    What happens after that claim is durable, up to the provider being handed
    the turn. Most of the delivery loop's own scheduling lives here.

Reported as one number they would average out: an improvement to the round
trip and an unchanged wait in the delivery loop would combine into a figure
that looked like progress everywhere. They are different costs with different
causes, and a revision can move one without touching the other.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tests.benchmarks.host import BenchWatcher, await_dispatches, marked, new_marker
from tests.benchmarks.metrics import ResourceReport, ResourceSampler
from tests.benchmarks.server import BenchAgent, BenchCore, BenchServer
from tests.benchmarks.trace import (
    ADMISSION_RECEIVED,
    ADMISSION_RESPONDED,
    CORE_COMMIT,
    PROVIDER_DISPATCH,
    SSE_PUSH,
    ClockResidual,
    LatencyReport,
    TraceCollector,
    clock_residual,
    correlation_for,
    format_table,
    measure,
)

#: How often the resource sampler reads the process tree and the socket table.
#: Fast enough to catch a session's startup peak, slow enough that `ps` and
#: `lsof` are not themselves a measurable share of the CPU being attributed.
SAMPLE_INTERVAL_SECONDS = 0.5

#: Per-message allowance when waiting for dispatches, on top of a fixed floor.
#: Generous: a timeout here fails the run, and a benchmark that flakes under
#: load reports nothing at all about the load.
SECONDS_PER_MESSAGE = 2.0
DISPATCH_FLOOR_SECONDS = 90.0

#: How long a watcher may take to get its inbound connection registered before
#: the run is called broken. Startup, not steady state, so generous.
STREAM_TIMEOUT_SECONDS = 60.0


def dispatch_timeout(messages: int) -> float:
    return DISPATCH_FLOOR_SECONDS + SECONDS_PER_MESSAGE * messages


async def dispatch_wait(
    watcher: BenchWatcher, markers: dict[str, str], timeout: float
) -> frozenset[str]:
    """Wait for every dispatch without blocking the loop the server runs on.

    The Switch server under measurement is in this process and on this event
    loop, so a blocking poll here would stall the thing being measured and
    price its own wait into the result.

    Returns the correlations that never reached a provider.
    """
    return await asyncio.to_thread(await_dispatches, watcher, markers, timeout)


async def await_stream(bench: BenchServer, agent_id: str, timeout: float) -> None:
    """Block until the watcher's inbound connection is registered on the server.

    Not politeness, and not a substitute for measuring startup: the watcher's
    supervisor exists before its stream does, and a message addressed into that
    window is never delivered to it at all — the stream opens at cursor zero and
    is advanced to the present rather than replaying what it missed. Posting
    before the stream exists therefore measures nothing and loses the message.

    Waited on the server's own connection registry, so what is waited for is the
    server agreeing the stream is open, not a guess at how long that takes.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if bench.connections.for_agent(agent_id):
            return
        await asyncio.sleep(0.05)
    raise TimeoutError(
        f"agent {agent_id} had opened no inbound connection {timeout}s after its "
        "watcher supervisor started, so there was nothing to address"
    )


def sampler_for(
    bench: BenchServer, watcher: BenchWatcher, agent_id: str
) -> ResourceSampler:
    return _sampler(
        watcher=watcher,
        port=bench.port,
        # The registry is in this process, so the server's own count of the
        # agent's open protocol connections is free to read alongside the
        # kernel's count of sockets.
        count_streams=lambda: len(bench.connections.for_agent(agent_id)),
    )


def sampler_for_core(
    core: BenchCore, watcher: BenchWatcher, agent_id: str
) -> ResourceSampler:
    """`sampler_for`, for a scenario that replaces the Core while it samples.

    The connection count is read off whichever Core is serving at the moment of
    the sample. Bound to one of them instead, every sample after a restart
    would be taken from a registry nothing is connected to any more, and the
    peak would be whatever the count happened to be when the old Core died.
    """
    return _sampler(
        watcher=watcher,
        # Kept across a restart by design, so reading it once is reading the
        # address the hosts are still pointed at.
        port=core.server.port,
        count_streams=lambda: len(core.server.connections.for_agent(agent_id)),
    )


def _sampler(
    *, watcher: BenchWatcher, port: int, count_streams: Callable[[], int]
) -> ResourceSampler:
    # Both trees: the server runs in this process, and the hosts hang off the
    # detached watcher supervisor, which is not a descendant of it.
    return ResourceSampler(
        root_pids=lambda: [os.getpid(), watcher.supervisor_pid],
        port=port,
        count_streams=count_streams,
        interval_seconds=SAMPLE_INTERVAL_SECONDS,
    )


#: The spans reported for every workload, in the order they occur.
SPANS = (
    ("sse push → admission received", SSE_PUSH, ADMISSION_RECEIVED),
    ("admission received → responded", ADMISSION_RECEIVED, ADMISSION_RESPONDED),
    ("core commit → provider dispatch", CORE_COMMIT, PROVIDER_DISPATCH),
)


@dataclass(frozen=True, slots=True)
class Posted:
    """The messages one workload sent, and which of them started a session.

    `cold` is the first message addressed into each room. That message waits
    for a host process to be spawned, started and connected before anything can
    claim it, so its latency is dominated by process startup — a cost paid once
    per session, not once per message. Pooled with the rest it would swamp
    them; dropped it would hide the cost of the topology's cold path, which at
    fifty sessions is most of what the topology does.

    The rest are warm only because they are posted in later rounds, once the
    cold round has been served. Posting a room's messages back to back would
    put every one of them behind the same process startup and report a warm
    figure indistinguishable from the cold one.
    """

    markers: dict[str, str]
    cold: frozenset[str]


async def post_round(
    *,
    bench: BenchServer,
    poster: BenchAgent,
    target: BenchAgent,
    room_ids: list[str],
    concurrent: bool,
) -> dict[str, str]:
    """Address one marked message into each room, and map marker → correlation.

    That map is what lets a host-side record be matched to the server-side
    ones: a host is handed command text and never learns the id Switch minted,
    so the driver carries the mapping.

    `concurrent` decides whether the rooms are addressed one after another or
    all at once. Sequential measures a loaded server; concurrent measures the
    same messages arriving together, which is the case where a shared inbound
    connection and a per-session one differ most.
    """
    markers: dict[str, str] = {}

    async def address(room_id: str) -> None:
        marker = new_marker()
        message_id = await bench.address(
            sender=poster,
            room_id=room_id,
            target=target.name,
            body=f"@{target.name} {marked(marker)}",
        )
        markers[marker] = correlation_for(room_id, message_id)

    if concurrent:
        await asyncio.gather(*(address(room_id) for room_id in room_ids))
    else:
        for room_id in room_ids:
            await address(room_id)
    return markers


def score(
    *,
    label: str,
    rooms: int,
    collector: TraceCollector,
    posted: Posted,
    undelivered: frozenset[str],
    resources: ResourceReport,
) -> WorkloadResult:
    """Turn one workload's traces into the figures that get reported.

    Latency is scored over what was delivered, and what was not is counted and
    reported beside it. Scoring the undelivered as missing span ends instead
    would bury a delivery failure in a measurement complaint; dropping it
    without a count would make a workload the topology could not serve look
    like one it served quickly.

    Delivering a message twice is counted too, and separately. It is the
    opposite failure and it does not show up in any of the other figures: an
    extra dispatch adds no latency, loses nothing, and leaves the counts of
    sent and served messages agreeing with each other. It is counted over
    everything posted rather than over what was delivered, because a message
    dispatched twice and completed neither time is a duplicate and a delivery
    failure at once — scored over the delivered subset it would show only as
    the second, which reads as the topology being slow rather than confused.
    """
    posted_correlations = set(posted.markers.values())
    duplicated = collector.subset(posted_correlations).repeats(PROVIDER_DISPATCH)
    correlations = posted_correlations - undelivered
    scoped = collector.subset(correlations)
    populations = (
        ("cold", posted.cold & correlations),
        ("warm", correlations - posted.cold),
    )
    latencies: list[LatencyReport] = []
    unmeasured: set[str] = set()
    for name, start, end in SPANS:
        for suffix, members in populations:
            if not members:
                continue
            report, missing = measure(
                scoped.subset(members),
                start_point=start,
                end_point=end,
                name=f"{name} [{suffix}]",
            )
            latencies.append(report)
            unmeasured.update(missing)
    return WorkloadResult(
        label=label,
        rooms=rooms,
        messages=len(posted.markers),
        undelivered=tuple(sorted(undelivered)),
        duplicated=tuple(sorted(duplicated.items())),
        resources=resources,
        latencies=tuple(latencies),
        residual=clock_residual(scoped),
        unmeasured=tuple(sorted(unmeasured)),
    )


@dataclass(frozen=True, slots=True)
class WorkloadResult:
    label: str
    rooms: int
    messages: int
    #: Correlations that never reached a provider, named rather than counted so
    #: a loss can be traced to the room and message it happened in.
    undelivered: tuple[str, ...]
    #: Correlations dispatched to a provider more than once, with how many
    #: times. A message executed twice is a correctness failure that costs no
    #: latency and loses nothing, so it is reported on its own or not at all.
    duplicated: tuple[tuple[str, int], ...]
    resources: ResourceReport
    latencies: tuple[LatencyReport, ...]
    residual: ClockResidual
    unmeasured: tuple[str, ...]


async def run_workload(
    *,
    bench: BenchServer,
    watcher: BenchWatcher,
    collector: TraceCollector,
    poster: BenchAgent,
    target: BenchAgent,
    room_ids: list[str],
    per_room: int,
    concurrent: bool,
    label: str,
) -> WorkloadResult:
    """Post one workload's messages in rounds, wait for each, and score it.

    A round is one message into every room, and the next round is not posted
    until this one has been served. That ordering is the only thing separating
    the cold path from the warm one: posted back to back, a room's second and
    third messages queue behind the very process startup the first is waiting
    for, and the warm figures come out equal to the cold ones.
    """
    await await_stream(bench, target.agent_id, STREAM_TIMEOUT_SECONDS)
    markers: dict[str, str] = {}
    cold: dict[str, str] = {}
    undelivered: set[str] = set()
    sampler = sampler_for(bench, watcher, target.agent_id)
    async with sampler.running(label):
        for round_index in range(per_room):
            sent = await post_round(
                bench=bench,
                poster=poster,
                target=target,
                room_ids=room_ids,
                concurrent=concurrent,
            )
            if round_index == 0:
                cold = sent
            markers.update(sent)
            undelivered |= await dispatch_wait(
                watcher, sent, dispatch_timeout(len(sent))
            )
    posted = Posted(markers=markers, cold=frozenset(cold.values()))
    collector.ingest_jsonl(watcher.trace_path, posted.markers)
    return score(
        label=label,
        rooms=len(room_ids),
        collector=collector,
        posted=posted,
        undelivered=frozenset(undelivered),
        resources=sampler.last_report,
    )


def render(results: list[WorkloadResult]) -> str:
    """The baseline report, as one block of text.

    Written for a Slack-bridged room and a terminal alike: one line per item
    with its label, no table characters that a chat client will mangle.
    """
    out: list[str] = []
    for result in results:
        resources = result.resources
        out.append(f"### {result.label}")
        out.append(
            f"rooms/sessions {result.rooms} · messages {result.messages} · "
            f"never delivered {len(result.undelivered)} · "
            f"delivered twice {len(result.duplicated)} · "
            f"wall {resources.wall_seconds:.1f}s · samples {resources.samples}"
        )
        out.append(
            f"peak agent protocol connections {resources.peak_streams} · "
            f"peak TCP sockets to the server {resources.peak_connections} · "
            f"peak processes {resources.peak_process_count} · "
            f"peak RSS {resources.peak_rss_mib:.0f} MiB · "
            f"CPU {resources.cpu_seconds:.1f}s"
        )
        out.append("")
        out.append(format_table(result.latencies))
        residual = result.residual
        out.append(
            f"clock drift: worst wall-vs-monotonic disagreement "
            f"{residual.worst_drift_ms:.2f} ms across {residual.processes} "
            f"process(es) over {residual.span_seconds:.1f}s"
        )
        if result.undelivered:
            out.append(
                f"NOT SERVED: {len(result.undelivered)} of {result.messages} messages "
                "never reached a provider; the latency above is over the rest"
            )
            # Listed, not just counted: a lost message is the kind of finding
            # someone has to go and read the room's journals about, and a bare
            # count gives them nowhere to start.
            out.extend(f"  not served: {lost}" for lost in result.undelivered)
        if result.duplicated:
            out.append(
                f"SERVED TWICE: {len(result.duplicated)} of {result.messages} "
                "messages were dispatched to a provider more than once; the work "
                "was done repeatedly and the latency above is over the first "
                "dispatch of each"
            )
            out.extend(
                f"  served {count}x: {correlation}"
                for correlation, count in result.duplicated
            )
        if result.unmeasured:
            out.append(
                f"UNMEASURED: {len(result.unmeasured)} correlations lacked a point; "
                "the percentiles above are over a partial population"
            )
        out.append("")
    return "\n".join(out)


def publish(results: list[WorkloadResult], path: Path) -> str:
    """Write the report beside the run and return it for printing."""
    text = render(results)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text
