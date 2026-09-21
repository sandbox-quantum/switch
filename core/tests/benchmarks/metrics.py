"""Process, connection and resource counts for a benchmark run.

Everything here is read from the operating system rather than from the code
under study. That is deliberate for the headline number: "one inbound
connection per agent" is a claim about sockets, and the connection registry is
only what the server *believes* about them. A run that leaked a socket the
registry had forgotten would look perfect from the inside.

`ps` and `lsof` rather than psutil, so the benchmark adds no dependency to a
service that does not need one at runtime. The cost is POSIX-only and a CPU
figure that is cumulative rather than sampled — which is the better measure
here anyway: total CPU seconds consumed while serving a fixed workload is
comparable between revisions, where an instantaneous percentage taken at an
arbitrary moment is not.
"""

from __future__ import annotations

import asyncio
import subprocess
import time
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ProcessSample:
    pid: int
    rss_kib: int
    cpu_seconds: float
    command: str


@dataclass(frozen=True, slots=True)
class ResourceReport:
    """What one workload cost, in processes, memory, CPU and connections.

    `peak_rss_kib` is the largest *total* across the whole process set at any
    one sample, not the largest any single process reached: the question the
    topology poses is what a machine has to hold at once.

    `peak_connections` and `peak_streams` answer the same question from the two
    sides and are both reported because they differ. The first is every
    established TCP connection to the server's port, which includes the pooled
    sockets a host uses for its ordinary HTTP calls; the second is the agent
    protocol connections the server itself believes are open. The ticket's
    claim is about the second, and the first is what the machine actually
    holds — a gap between them that grows with the session count is itself a
    finding.
    """

    label: str
    wall_seconds: float
    samples: int
    peak_process_count: int
    peak_rss_kib: int
    peak_connections: int
    peak_streams: int
    cpu_seconds: float

    @property
    def peak_rss_mib(self) -> float:
        return self.peak_rss_kib / 1024


def _run(argv: Sequence[str]) -> str:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    # `ps` and `lsof` both exit non-zero when a pid or socket has simply gone,
    # which is ordinary here. An empty result is the answer in that case; a
    # missing binary is not, and raises from `subprocess` itself.
    return result.stdout


def _cpu_seconds(field: str) -> float:
    """Parse a `ps` TIME field: `[[DD-]HH:]MM:SS[.ss]`."""
    days = 0
    if "-" in field:
        head, field = field.split("-", 1)
        days = int(head)
    parts = field.split(":")
    if len(parts) == 2:
        hours, minutes, seconds = 0, int(parts[0]), float(parts[1])
    elif len(parts) == 3:
        hours, minutes, seconds = int(parts[0]), int(parts[1]), float(parts[2])
    else:
        raise ValueError(f"unrecognised ps TIME field: {field!r}")
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def sample_processes(pids: Iterable[int]) -> dict[int, ProcessSample]:
    """RSS and cumulative CPU for each pid that is still alive.

    A pid that has exited is absent from the result rather than zero: a dead
    worker contributes no memory, and recording it as using none would be
    indistinguishable from one that was running and idle.
    """
    wanted = sorted(set(pids))
    if not wanted:
        return {}
    output = _run(
        ["ps", "-o", "pid=,rss=,time=,comm=", "-p", ",".join(str(p) for p in wanted)]
    )
    samples: dict[int, ProcessSample] = {}
    for line in output.splitlines():
        fields = line.split(maxsplit=3)
        if len(fields) < 4:
            continue
        pid = int(fields[0])
        samples[pid] = ProcessSample(
            pid=pid,
            rss_kib=int(fields[1]),
            cpu_seconds=_cpu_seconds(fields[2]),
            command=fields[3],
        )
    return samples


def descendants(root_pid: int) -> list[int]:
    """Every process under `root_pid`, inclusive.

    The benchmark's worker processes are spawned detached, into their own
    process groups, so a group-based lookup would miss them. The parent/child
    chain is what actually holds.
    """
    children: dict[int, list[int]] = {}
    for line in _run(["ps", "-eo", "pid=,ppid="]).splitlines():
        fields = line.split()
        if len(fields) != 2:
            continue
        children.setdefault(int(fields[1]), []).append(int(fields[0]))
    found = [root_pid]
    queue = [root_pid]
    while queue:
        for child in children.get(queue.pop(), ()):
            found.append(child)
            queue.append(child)
    return found


def established_connections(port: int) -> int:
    """Live inbound TCP connections to the benchmark server's port.

    The number the ticket is about, read from the kernel rather than from the
    connection registry, so a socket the server has lost track of still counts.
    """
    output = _run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:ESTABLISHED", "-F", "n"])
    # `lsof -F n` prints one `n<name>` line per file. Each established
    # connection appears twice on loopback — once for each end — so the pairs
    # are counted, not the lines.
    names = [line[1:] for line in output.splitlines() if line.startswith("n")]
    inbound = [name for name in names if name.split("->")[-1].endswith(f":{port}")]
    return len(inbound)


class ResourceSampler:
    """Polls the process tree and the server's port for the life of a workload.

    Sampling rather than reading once at the end, because the peak matters: a
    topology that briefly holds fifty processes and then collapses to one costs
    the machine fifty, and an end-of-run reading would report one.
    """

    def __init__(
        self,
        *,
        root_pids: Sequence[int],
        port: int,
        count_streams: Callable[[], int],
        interval_seconds: float,
    ) -> None:
        # More than one root because the two halves of a run are not in one
        # process tree: the server runs inside the driver, while the hosts are
        # spawned detached and reparented away from it. Counting either alone
        # would answer half the question.
        self._root_pids = tuple(root_pids)
        self._port = port
        self._count_streams = count_streams
        self._interval = interval_seconds
        self._peak_streams = 0
        self._first: dict[int, ProcessSample] = {}
        self._last: dict[int, ProcessSample] = {}
        self._peak_rss_kib = 0
        self._peak_processes = 0
        self._peak_connections = 0
        self._samples = 0
        self._last_report: ResourceReport | None = None

    @asynccontextmanager
    async def running(self, label: str) -> AsyncIterator[None]:
        """Sample in the background for the life of the block.

        Yields nothing; the totals are collected afterwards with `report`,
        because a workload should not have to thread a report object through
        itself to be measured.
        """
        started = time.monotonic()
        self.sample()
        task = asyncio.create_task(self._poll())
        try:
            yield
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            self.sample()
            self._last_report = self.report(label, time.monotonic() - started)

    @property
    def last_report(self) -> ResourceReport:
        if self._last_report is None:
            raise ValueError("no workload has been sampled yet")
        return self._last_report

    async def _poll(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            self.sample()

    def sample(self) -> None:
        tree = {pid for root in self._root_pids for pid in descendants(root)}
        processes = sample_processes(tree)
        connections = established_connections(self._port)
        if not self._first:
            self._first = processes
        self._last = processes
        self._samples += 1
        self._peak_processes = max(self._peak_processes, len(processes))
        self._peak_connections = max(self._peak_connections, connections)
        self._peak_streams = max(self._peak_streams, self._count_streams())
        self._peak_rss_kib = max(
            self._peak_rss_kib, sum(s.rss_kib for s in processes.values())
        )

    def report(self, label: str, wall_seconds: float) -> ResourceReport:
        """Total the run, attributing CPU only where both ends were observed.

        A process that started after the first sample has no baseline to
        subtract, so its whole lifetime counts; one that exited before the last
        sample took its counter with it and contributes nothing. Neither is
        guessed at, and the sample count is reported so a run too short to have
        seen the peak is visible as such.
        """
        if self._samples == 0:
            raise ValueError(
                f"{label}: the sampler was never run, so there are no resource "
                "figures for this workload"
            )
        consumed = 0.0
        for pid, end in self._last.items():
            start = self._first.get(pid)
            consumed += end.cpu_seconds - (start.cpu_seconds if start else 0.0)
        return ResourceReport(
            label=label,
            wall_seconds=wall_seconds,
            samples=self._samples,
            peak_process_count=self._peak_processes,
            peak_rss_kib=self._peak_rss_kib,
            peak_connections=self._peak_connections,
            peak_streams=self._peak_streams,
            cpu_seconds=consumed,
        )
