"""Correlated trace records for the connection-model baseline benchmark.

The comparison this supports is workload-to-workload across two revisions, not
stage-to-stage: the baseline has no controller and no controller-to-worker
handoff, so only points that exist on *both* revisions may be instrumented.
Those points are:

``sse_push``
    Switch wrote the room event onto the agent's stream. Server-side.
``admission_received``
    The host's ``room-message`` admission request reached Switch. Server-side.
``core_commit``
    The database transaction for that admission committed. Server-side.
``admission_responded``
    Switch finished writing the admission response. Server-side.
``provider_dispatch``
    The host handed the resulting command to its provider adapter. Host-side,
    reported by the benchmark's fake adapter.

None of those is a production code change: the four server points are observed
by wrapping the ASGI app and listening on the engine the harness itself built,
and the host point is emitted by benchmark code.

**Clocks.** Every record carries both a wall reading and a monotonic one.
Within one process, use monotonic — it cannot step. Across the process
boundary (``core_commit`` → ``provider_dispatch`` spans Python and Node) the
two monotonic scales share no origin that is safe to assume, so those spans are
computed from the wall clock and the residual error is reported rather than
hidden; see `LatencyReport.cross_process`.
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Container, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path

SSE_PUSH = "sse_push"
ADMISSION_RECEIVED = "admission_received"
CORE_COMMIT = "core_commit"
ADMISSION_RESPONDED = "admission_responded"
PROVIDER_DISPATCH = "provider_dispatch"

#: Points recorded inside the Switch server process.
SERVER_POINTS = frozenset(
    {SSE_PUSH, ADMISSION_RECEIVED, CORE_COMMIT, ADMISSION_RESPONDED}
)
#: Points recorded inside a host (Node) process.
HOST_POINTS = frozenset({PROVIDER_DISPATCH})


def correlation_for(room_id: str, message_id: str) -> str:
    """The identity a room event keeps from stream push to provider dispatch.

    Room id and message id are the only pair carried unchanged across every
    point: the SSE payload has both, the admission request body has both, and
    the command the provider is handed is derived from them. A sequence number
    would not do — it is reset by a server restart, which is one of the
    recovery cases the harness exercises.
    """
    return f"{room_id}/{message_id}"


@dataclass(frozen=True, slots=True)
class TraceRecord:
    point: str
    correlation: str
    wall_ns: int
    mono_ns: int
    process: str
    detail: dict[str, object] = field(default_factory=dict)

    @staticmethod
    def now(
        point: str,
        correlation: str,
        *,
        process: str,
        detail: dict[str, object] | None = None,
    ) -> TraceRecord:
        return TraceRecord(
            point=point,
            correlation=correlation,
            wall_ns=time.time_ns(),
            mono_ns=time.monotonic_ns(),
            process=process,
            detail=detail or {},
        )


class TraceCollector:
    """Accumulates trace records from every process in one run.

    Server-side points are appended directly. Host-side points arrive as JSON
    lines written by the benchmark entrypoint, and are merged with `ingest_jsonl`.
    """

    def __init__(self) -> None:
        self._records: list[TraceRecord] = []

    def add(self, record: TraceRecord) -> None:
        self._records.append(record)

    def record(
        self,
        point: str,
        correlation: str,
        *,
        process: str = "switch-core",
        detail: dict[str, object] | None = None,
    ) -> None:
        self.add(TraceRecord.now(point, correlation, process=process, detail=detail))

    def ingest_jsonl(self, path: Path, correlations: Mapping[str, str]) -> int:
        """Merge host-emitted trace records. Returns how many were read.

        A host labels its records with the marker the driver put in the message
        body, because it never learns the id Switch minted for that message;
        `correlations` maps those markers onto the canonical room/message
        correlation the server-side points use.

        A malformed line, or a marker with no mapping, is an error rather than
        something to skip. A silently dropped record becomes a missing span,
        and a missing span becomes a percentile computed over the wrong
        population — which reads as a result rather than as a fault.
        """
        if not path.exists():
            return 0
        text = path.read_text()
        count = 0
        for number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except ValueError as exc:
                raise ValueError(
                    f"{path}:{number} is not valid JSON; the host trace is "
                    f"truncated or corrupt and the run cannot be scored: {line!r}"
                ) from exc
            marker = str(raw["correlation"])
            if marker not in correlations:
                raise ValueError(
                    f"{path}:{number} reports {raw['point']} for {marker!r}, which "
                    "the driver never sent. The host dispatched something the "
                    "benchmark did not create; the run cannot be scored."
                )
            self.add(
                TraceRecord(
                    point=str(raw["point"]),
                    correlation=correlations[marker],
                    wall_ns=int(raw["wall_ns"]),
                    mono_ns=int(raw["mono_ns"]),
                    process=str(raw["process"]),
                    detail=dict(raw["detail"]),
                )
            )
            count += 1
        return count

    @property
    def records(self) -> Sequence[TraceRecord]:
        return tuple(self._records)

    def subset(self, correlations: Container[str]) -> TraceCollector:
        """A collector holding only the records for the given correlations.

        One server serves every workload in a run, so its instrumentation keeps
        filling one collector. Scoring a workload against that would average it
        with the ones before it — and since the workloads differ precisely in
        how loaded the server is, that would erase the effect being measured.
        """
        scoped = TraceCollector()
        for record in self._records:
            if record.correlation in correlations:
                scoped.add(record)
        return scoped

    def by_correlation(self) -> dict[str, dict[str, TraceRecord]]:
        """First record of each point, per correlation.

        First, not last: a retried admission is a second `admission_received`
        for the same message, and the latency being measured is the one the
        room actually waited for.
        """
        out: dict[str, dict[str, TraceRecord]] = {}
        for record in self._records:
            points = out.setdefault(record.correlation, {})
            if record.point not in points:
                points[record.point] = record
        return out

    def write_jsonl(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(asdict(record)) + "\n" for record in self._records)
        )


def percentile(values: Sequence[float], fraction: float) -> float:
    """Linear-interpolated percentile.

    Raises on an empty population rather than returning zero: a zero here would
    read as "instant" in the metric table, which is the one wrong answer that
    looks like a good result.
    """
    if not values:
        raise ValueError("no samples: a percentile over nothing has no meaning")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


@dataclass(frozen=True, slots=True)
class LatencyReport:
    """One latency measure over one run.

    `cross_process` records whether the span was computed from wall-clock
    readings taken in two different processes. When it is true the numbers
    carry the clock-comparison caveat and must be reported with it.
    """

    name: str
    unit: str
    samples: int
    expected: int
    cross_process: bool
    p50: float
    p95: float
    p99: float
    minimum: float
    maximum: float

    @property
    def complete(self) -> bool:
        return self.samples == self.expected

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def summarise(
    name: str,
    values: Sequence[float],
    *,
    expected: int,
    cross_process: bool,
    unit: str = "ms",
) -> LatencyReport:
    return LatencyReport(
        name=name,
        unit=unit,
        samples=len(values),
        expected=expected,
        cross_process=cross_process,
        p50=percentile(values, 0.50),
        p95=percentile(values, 0.95),
        p99=percentile(values, 0.99),
        minimum=min(values),
        maximum=max(values),
    )


def span_ms(start: TraceRecord, end: TraceRecord) -> float:
    """Elapsed milliseconds between two points.

    Monotonic when both were taken in the same process, wall clock when they
    were not. Mixing the two scales silently is the failure this guards: the
    offset between an arbitrary pair of monotonic origins is unbounded, so a
    cross-process monotonic subtraction can produce a plausible-looking number
    that is wrong by the age of one of the machines' boots.
    """
    if start.process == end.process:
        return (end.mono_ns - start.mono_ns) / 1_000_000
    return (end.wall_ns - start.wall_ns) / 1_000_000


def measure(
    collector: TraceCollector,
    *,
    start_point: str,
    end_point: str,
    name: str,
) -> tuple[LatencyReport, list[str]]:
    """Summarise one span across every correlated message in the run.

    Returns the report and the correlations that could not be measured, so an
    incomplete population is visible in the output instead of quietly
    shrinking the sample count.
    """
    grouped = collector.by_correlation()
    values: list[float] = []
    missing: list[str] = []
    cross_process = False
    for correlation, points in sorted(grouped.items()):
        start = points.get(start_point)
        end = points.get(end_point)
        if start is None or end is None:
            missing.append(correlation)
            continue
        if start.process != end.process:
            cross_process = True
        values.append(span_ms(start, end))
    if not values:
        raise ValueError(
            f"{name}: no correlation had both {start_point} and {end_point}; "
            f"{len(missing)} incomplete. The run produced no measurable span, "
            "which is a harness failure, not a latency of zero."
        )
    return (
        summarise(name, values, expected=len(grouped), cross_process=cross_process),
        missing,
    )


@dataclass(frozen=True, slots=True)
class ClockResidual:
    """How far the wall clock drifted from the monotonic one during a run.

    A cross-process span is computed from wall-clock readings, because that is
    the only scale the two processes share: their monotonic clocks have
    unrelated origins, so subtracting one from the other yields the gap between
    those origins and says nothing about elapsed time.

    What can go wrong with the wall clock is that it steps or slews while the
    run is in progress, and that *is* measurable — within a single process,
    where both scales are available over the same interval. Comparing the two
    elapsed times between that process's first and last record bounds the error
    the reported spans could be carrying. A figure near zero means the wall
    clock behaved like a monotonic one for the length of the run, which is the
    condition the cross-process spans rely on.
    """

    processes: int
    span_seconds: float
    worst_drift_ms: float


def clock_residual(collector: TraceCollector) -> ClockResidual:
    """Worst wall-versus-monotonic drift observed in any one process."""
    extremes: dict[str, tuple[TraceRecord, TraceRecord]] = {}
    for record in collector.records:
        first, last = extremes.get(record.process, (record, record))
        if record.mono_ns < first.mono_ns:
            first = record
        if record.mono_ns > last.mono_ns:
            last = record
        extremes[record.process] = (first, last)
    drifts: list[float] = []
    longest = 0.0
    for first, last in extremes.values():
        elapsed = (last.mono_ns - first.mono_ns) / 1_000_000_000
        if elapsed <= 0:
            # One record, or several within the clock's resolution: there is no
            # interval to measure drift over, and calling that zero drift would
            # claim evidence the run does not have.
            continue
        longest = max(longest, elapsed)
        wall = (last.wall_ns - first.wall_ns) / 1_000_000
        mono = (last.mono_ns - first.mono_ns) / 1_000_000
        drifts.append(abs(wall - mono))
    if not drifts:
        raise ValueError(
            "no process recorded two points far enough apart to measure clock "
            "drift, so the cross-process spans have no error bound"
        )
    return ClockResidual(
        processes=len(drifts),
        span_seconds=longest,
        worst_drift_ms=max(drifts),
    )


def format_table(reports: Iterable[LatencyReport]) -> str:
    rows = list(reports)
    if not rows:
        return "(no latency measures)"
    header = f"{'measure':<34} {'n':>6} {'p50':>9} {'p95':>9} {'p99':>9} {'max':>9}"
    lines = [header, "-" * len(header)]
    for report in rows:
        flag = "" if report.complete else f"  ({report.samples}/{report.expected})"
        cross = " *" if report.cross_process else ""
        lines.append(
            f"{report.name + cross:<34} {report.samples:>6} "
            f"{report.p50:>9.2f} {report.p95:>9.2f} {report.p99:>9.2f} "
            f"{report.maximum:>9.2f}{flag}"
        )
    if any(report.cross_process for report in rows):
        lines.append("")
        lines.append(
            "* spans two processes: computed from wall clock, not monotonic "
            "(see clock_residual)"
        )
    return "\n".join(lines)
