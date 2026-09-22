"""Runs the real Node host topology against the benchmark's own server.

What the connection model costs is decided almost entirely on this side: the
watcher, the per-session supervisors and the session workers are what open the
inbound connections and occupy the processes being counted. So the benchmark
runs the shipped ones. The only substitution is the provider adapter, made in
the benchmark's own entrypoint under
`console/packages/agent-providers/src/host/bench/`.

Two isolations matter, and both are load-bearing rather than tidiness:

`HOME` is redirected
    A watcher restarts every session of its agent that is running a superseded
    build. Sessions are found by scanning `$HOME/.local/state/switch`, so a
    benchmark watcher sharing a home directory with a real Switch Console
    would restart that user's live sessions.
the agent is registered per run
    A watcher acts on its agent id. A fresh id per run means a benchmark can
    never reach a session it did not create, whatever the state on disk.
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from tests.benchmarks.metrics import descendants
from tests.benchmarks.trace import PROVIDER_DISPATCH

#: Prefix of the token the driver embeds in each message body, matched by
#: `benchMarker` in the benchmark adapter. The two must agree.
MARKER_PREFIX = "switch-bench:"

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CONSOLE = _REPO_ROOT / "console"
_BUNDLE = (
    _CONSOLE / "packages" / "agent-providers" / "dist-bench" / "bench-host-daemon.mjs"
)

SESSION_CAPABILITIES = {
    "input": "queue",
    "approvals": False,
    "questions": False,
    "interrupt": False,
    "reset": False,
    "compact": False,
    "modelChange": False,
    "attachmentMimeTypes": [],
}


def new_marker() -> str:
    """A token identifying one benchmark message, as the host will report it."""
    return str(uuid.uuid4())


def marked(marker: str) -> str:
    """The marker as it must appear in a message body for a host to find it."""
    return f"{MARKER_PREFIX}{marker}"


def build_bench_bundle() -> Path:
    """Bundle the benchmark host entrypoint, returning the bundle path.

    Bundled rather than run from source because a host is a child process and
    the entrypoint imports its package by extensionless specifier, which Node's
    own TypeScript support does not resolve. Built every run so a benchmark can
    never score a revision against a bundle left over from another one.
    """
    if not _CONSOLE.is_dir():
        raise RuntimeError(
            f"{_CONSOLE} is missing; the benchmark needs the Console workspace to "
            "build its host entrypoint"
        )
    result = subprocess.run(
        [
            "pnpm",
            "--filter",
            "@switch-console/agent-providers",
            "exec",
            "tsdown",
            "--config",
            "tsdown.bench.config.ts",
        ],
        cwd=_CONSOLE,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "building the benchmark host entrypoint failed. Run `pnpm install` in "
            f"{_CONSOLE} first.\n{result.stdout}\n{result.stderr}"
        )
    if not _BUNDLE.is_file():
        raise RuntimeError(f"the bundler reported success but {_BUNDLE} is not there")
    return _BUNDLE


@dataclass(frozen=True, slots=True)
class BenchWatcher:
    """A running watcher and everything spawned beneath it."""

    root: Path
    home: Path
    trace_path: Path
    supervisor_pid: int

    def process_tree(self) -> list[int]:
        return descendants(self.supervisor_pid)

    def failure(self) -> str | None:
        """The message a host wrote before dying, if one did.

        Hosts are detached and their output goes to log files, so a failure is
        otherwise visible only as a workload that never completes.
        """
        for path in sorted(self.home.rglob("failure.json")):
            return str(json.loads(path.read_text())["message"])
        return None

    def sessions_by_room(self) -> dict[str, str]:
        """Which session the watcher assigned to each room.

        Read from the watcher's own durable journal rather than inferred, so
        the recovery case acts on the session that is really serving a room.
        """
        journal = self.root / "assignments.jsonl"
        if not journal.exists():
            return {}
        assigned: dict[str, str] = {}
        for line in journal.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            # The journal also carries sequence bookkeeping — a numbering
            # restart, a routed sequence, a held delivery and its release —
            # and none of those name a session. An assignment is the record
            # that carries the session's configuration.
            if "config" not in record:
                continue
            assigned[record["roomId"]] = record["config"]["session"]["sessionId"]
        return assigned

    def session_tree(self, session_id: str) -> list[int]:
        """The processes serving one session, supervisor first."""
        digest = hashlib.sha256(session_id.encode()).hexdigest()
        owner = (
            (self.home / ".local" / "state" / "switch" / "sdk-sessions" / digest)
            / "supervisor"
            / "owner.json"
        )
        if not owner.exists():
            raise RuntimeError(f"session {session_id} has no supervisor at {owner}")
        return descendants(int(json.loads(owner.read_text())["pid"]))

    def kill_session(self, session_id: str) -> int:
        """Kill a session's processes outright, returning how many were hit.

        SIGKILL, not SIGTERM: the case being measured is a host lost without
        warning, and a graceful stop writes a `stopped` record that tells the
        watcher never to start that session again.
        """
        tree = self.session_tree(session_id)
        for pid in reversed(tree):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                continue
        return len(tree)


def _template(
    *,
    agent_id: str,
    credentials_path: Path,
    cwd: Path,
) -> dict[str, object]:
    session_id = str(uuid.uuid4())
    return {
        "session": {
            "sessionId": session_id,
            "agentId": agent_id,
            "provider": "claude",
            "hostId": str(uuid.uuid4()),
            "epoch": str(uuid.uuid4()),
            "status": "starting",
            "connectivity": "online",
            "capabilities": SESSION_CAPABILITIES,
            "pendingRequestIds": [],
        },
        "start": {
            "provider": "claude",
            "input": {
                "sessionId": session_id,
                "cwd": str(cwd),
                "runtimeMode": "approval-required",
                "env": {},
                "mcpServers": {},
            },
        },
        "roomConnection": {"connectionId": str(uuid.uuid4()), "rooms": []},
        "execution": {
            "credentialsPath": str(credentials_path),
            "inheritEnv": [],
            "mcpRuntime": "@sandboxaq/switch-agent-runtime",
            "codexConfig": "",
            "skill": "",
            "context": "",
        },
    }


@contextmanager
def bench_watcher(
    *,
    bundle: Path,
    home: Path,
    base_url: str,
    agent_id: str,
    api_key: str,
) -> Iterator[BenchWatcher]:
    """Start a watcher for one agent and stop its whole tree afterwards."""
    root = home / "watch"
    root.mkdir(parents=True)
    trace_path = home / "host-trace.jsonl"
    trace_path.touch()
    credentials_path = home / "credentials.json"
    credentials_path.write_text(
        json.dumps(
            {
                "env": {
                    "SWITCH_API_ENDPOINT": base_url,
                    "SWITCH_API_TOKEN": api_key,
                    "SWITCH_AGENT_ID": agent_id,
                }
            }
        )
    )
    # Connected and allowed to start sessions: the workload addresses rooms
    # nothing is running for, so a controller that may not spawn would measure
    # a topology with no sessions in it.
    (root / "watch.json").write_text(json.dumps({"enabled": True, "spawn": True}))
    template_path = home / "template.json"
    template_path.write_text(
        json.dumps(
            _template(agent_id=agent_id, credentials_path=credentials_path, cwd=home)
        )
    )

    environment = {
        **os.environ,
        "HOME": str(home),
        "SWITCH_BENCH_TRACE": str(trace_path),
    }
    started = subprocess.run(
        ["node", str(bundle), str(root), str(template_path), "--ensure-watch"],
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
    )
    if started.returncode != 0:
        raise RuntimeError(
            f"the benchmark watcher did not start.\n{started.stdout}\n{started.stderr}"
        )
    watcher = BenchWatcher(
        root=root,
        home=home,
        trace_path=trace_path,
        supervisor_pid=_await_supervisor(root),
    )
    try:
        yield watcher
    finally:
        _terminate(watcher.process_tree)


def _await_supervisor(root: Path) -> int:
    """The pid of the detached supervisor that now owns this root.

    Read from its own owner record rather than from the process that launched
    it: that process spawns the supervisor detached and exits, so the
    supervisor is reparented and is not in the driver's process tree.
    """
    owner = root / "supervisor" / "owner.json"
    failure = root / "supervisor" / "failure.json"
    deadline = time.monotonic() + 30.0
    while time.monotonic() < deadline:
        if failure.exists():
            raise RuntimeError(
                f"the benchmark watcher failed at startup: "
                f"{json.loads(failure.read_text())['message']}"
            )
        if owner.exists():
            return int(json.loads(owner.read_text())["pid"])
        time.sleep(0.05)
    raise RuntimeError(f"no watcher supervisor claimed {root} within 30s")


def _terminate(tree: Callable[[], list[int]]) -> None:
    """Stop a detached host tree, children first, and wait for it to be gone.

    The tree is re-read on every pass and accumulated rather than snapshotted
    once. A watcher spawns hosts continuously, so a single scan misses any host
    started between the scan and the signal; and once the supervisor dies its
    children are reparented, so they stop being reachable from it and a later
    scan would report the tree empty while they were still running.

    A survivor is not untidiness. The workloads share a machine and run one
    after another, so a host left serving the previous workload is CPU, memory
    and an inbound connection that the next workload's figures would be quietly
    charged for.
    """
    known: set[int] = set()
    for signum, grace in ((signal.SIGTERM, 15.0), (signal.SIGKILL, 10.0)):
        deadline = time.monotonic() + grace
        while True:
            known.update(tree())
            # Highest pid first, so a worker is signalled before the supervisor
            # that would otherwise notice it die and start a replacement.
            alive = sorted((pid for pid in known if _alive(pid)), reverse=True)
            if not alive:
                return
            for pid in alive:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    continue
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    remaining = [pid for pid in known if _alive(pid)]
    if remaining:
        raise RuntimeError(
            f"{len(remaining)} benchmark host process(es) survived SIGKILL: "
            f"{sorted(remaining)}. Anything measured after this would be sharing "
            "the machine with a workload that was supposed to be over."
        )


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def await_dispatches(
    watcher: BenchWatcher, markers: Mapping[str, str], timeout: float
) -> frozenset[str]:
    """Block until every marker has been dispatched, or the deadline passes.

    Returns the correlations that were never dispatched, rather than raising on
    them. Undelivered messages are a measurement here, not only a fault: past a
    certain session count the server refuses the agent further connections, and
    the rooms behind those connections are never served. A benchmark that
    aborted there would report nothing about the ceiling it had just hit.

    The caller decides what the loss means. Where every message is expected to
    arrive, the caller asserts the result is empty, so nothing is measured over
    a silently partial population.
    """
    outstanding = set(markers)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for line in watcher.trace_path.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if record["point"] == PROVIDER_DISPATCH:
                outstanding.discard(record["correlation"])
        if not outstanding:
            break
        time.sleep(0.05)
    return frozenset(markers[marker] for marker in outstanding)
