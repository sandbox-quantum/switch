"""Runs the real Node host topology against the benchmark's own server.

What the connection model costs is decided almost entirely on this side, so
the benchmark runs the shipped processes: a detached watcher supervisor, the
watcher it keeps running (which holds the agent's one connection, owns the
room → session map and makes every Switch call), and one session host per
session, each a child of the watcher talking to it over an IPC pipe and
serving the Switch MCP tools to its provider on loopback. The only
substitution is the provider, a scripted one, made in the benchmark's own
entrypoint under `console/packages/agent-providers/src/host/bench/`.

Two isolations matter, and both are load-bearing rather than tidiness:

`HOME` is redirected
    Session state lives under `$HOME/.local/state/switch`, and a watcher
    restarts sessions it finds there, so a benchmark watcher sharing a home
    directory with a real Switch Console could reach that user's sessions.
the agent is registered per run
    A watcher acts on its agent id. A fresh id per run means a benchmark can
    never reach a session it did not create, whatever the state on disk.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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

#: What a benchmark session says it can be asked to do. The scripted provider
#: asks for approvals when a message tells it to, so those are on; it answers
#: no questions and cannot be interrupted, compacted or moved between models.
SESSION_CAPABILITIES = {
    "input": "queue",
    "approvals": True,
    "questions": False,
    "interrupt": False,
    "reset": True,
    "compact": False,
    "modelChange": False,
    "attachmentMimeTypes": [],
}


#: Namespace Switch Console derives a controller's connection id under. It is
#: mirrored here rather than read from the app because the watcher takes the id
#: from the template it is handed, so a harness that minted its own would test a
#: connection identity no Console ever opens.
CONTROLLER_CONNECTION_NAMESPACE = uuid.UUID("c3f2b0de-2e5a-5a1e-9d4a-1f7c2a6b8e05")


def controller_connection_id(agent_id: str) -> str:
    """The connection a controller for this agent opens, as Console derives it.

    Derived from the agent rather than minted, so two controllers started for
    one agent collide on the server and one takes the connection from the
    other, and so a controller that is restarted reopens the connection it had
    instead of leaving a second one to be swept.
    """
    return str(uuid.uuid5(CONTROLLER_CONNECTION_NAMESPACE, agent_id))


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


def successor_bundle(bundle: Path) -> Path:
    """The same build again under a second identity, for an upgrade to it.

    A bench host names the path it was started from as its build, so one bundle
    at two paths is two builds running identical code — which is what an
    upgrade between consecutive releases of one topology does to a machine, and
    it needs no second checkout to stage.

    The copy goes beside the original because the bundle resolves its
    dependencies from the workspace it was built in; anywhere else it fails to
    load rather than running as an older build would.
    """
    successor = bundle.with_name(f"{bundle.stem}-successor{bundle.suffix}")
    shutil.copy2(bundle, successor)
    return successor


@dataclass(slots=True)
class BenchWatcher:
    """A running watcher and everything spawned beneath it.

    `supervisor_pid` is not fixed for the life of the run: a controller can be
    killed and another started on the same state, and everything that reads the
    process tree has to follow it to the one that is running now.
    """

    root: Path
    home: Path
    trace_path: Path
    bundle: Path
    connection_id: str
    template_path: Path
    environment: Mapping[str, str]
    supervisor_pid: int

    def process_tree(self) -> list[int]:
        return descendants(self.supervisor_pid)

    def failure(self) -> str | None:
        """The message a host or the watcher wrote before dying, if one did.

        Their output goes to log files, so a failure is otherwise visible only
        as a workload that never completes.
        """
        for path in sorted(self.home.rglob("failure.json")):
            return str(json.loads(path.read_text())["message"])
        return None

    def taken_over(self) -> dict[str, str] | None:
        """The record this controller left if another took its connection.

        Written when the server evicts it in favour of a second controller for
        the same agent, and kept: standing down is durable, so a controller
        that has this file is one that will not reopen the connection on its
        own.
        """
        record = self.root / "taken-over.json"
        if not record.exists():
            return None
        return {str(k): str(v) for k, v in json.loads(record.read_text()).items()}

    def controller_running(self) -> bool:
        """Whether this controller's supervisor is still up."""
        return alive(self.supervisor_pid)

    def worker_pid(self) -> int | None:
        """The watcher process the supervisor keeps running, if one is alive.

        It is the one holding the agent's connection and the parent of every
        session host, and it records itself in the lock it holds on the root.
        """
        return _owner(self.root / "shared-owner.lock")

    def sessions_by_room(self) -> dict[str, str]:
        """Which session the watcher has placed in each room.

        Read from `placements.json`, the map the watcher routes by and states
        to Switch, rather than inferred from what was delivered where.
        """
        path = self.root / "placements.json"
        if not path.exists():
            return {}
        placed = json.loads(path.read_text())["placements"]
        return {str(room): str(session) for session, room in placed.items()}

    def assigned_sessions(self) -> set[str]:
        """Every session this watcher ever started for a room, placed or not."""
        journal = self.root / "assignments.jsonl"
        if not journal.exists():
            return set()
        assigned: set[str] = set()
        for line in journal.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            # The journal also carries sequence bookkeeping — a numbering
            # restart, a routed sequence, a held delivery and its release —
            # and none of those name a session.
            if "config" in record:
                assigned.add(record["config"]["session"]["sessionId"])
        return assigned

    def session_root(self, session_id: str) -> Path:
        """Where a session of this watcher keeps its state on disk."""
        digest = hashlib.sha256(session_id.encode()).hexdigest()
        return self.home / ".local" / "state" / "switch" / "sdk-sessions" / digest

    def session_pid(self, session_id: str) -> int | None:
        """The session host's process, if one is running for this session."""
        return _owner(self.session_root(session_id) / "shared-owner.lock")

    def session_pids(self) -> set[int]:
        """Every session host running for a session this watcher started."""
        return {
            pid
            for session_id in self.assigned_sessions()
            if (pid := self.session_pid(session_id)) is not None
        }

    def parked(self, session_id: str) -> bool:
        """Whether the session's host last stopped by parking itself."""
        state = self.session_root(session_id) / "shared-state.jsonl"
        if not state.exists():
            return False
        last = None
        for line in state.read_text().splitlines():
            if line.strip():
                kind = json.loads(line)["type"]
                if kind in ("running", "parked"):
                    last = kind
        return last == "parked"

    def provider_conversations(self, session_id: str) -> list[str]:
        """The provider conversations this session has run, in order.

        One entry per time the provider named its conversation, which a start
        does both by announcing and by returning, so a single start can appear
        twice. What the identity says is what matters: a host that recovered a
        session resumes the identity it had, so an entry differing from the
        first is a session that came back as a new conversation rather than
        the one it was.
        """
        inbox = self.session_root(session_id) / "inbox.jsonl"
        if not inbox.exists():
            raise RuntimeError(f"session {session_id} has no inbox at {inbox}")
        native: list[str] = []
        for line in inbox.read_text().splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("type") == "native":
                native.append(record["nativeSessionId"])
        return native

    def kill_session(self, session_id: str) -> int:
        """Kill a session's host outright, returning its pid.

        SIGKILL, not SIGTERM: the case being measured is a host lost without
        warning, which writes nothing on the way out. The watcher that is its
        parent survives and is what has to bring it back.
        """
        pid = self.session_pid(session_id)
        if pid is None:
            raise RuntimeError(f"session {session_id} has no running host to kill")
        os.kill(pid, signal.SIGKILL)
        return pid

    def kill_worker(self) -> int:
        """Kill the watcher process, leaving the supervisor that keeps it running.

        The session hosts are its children and go with it; the supervisor is
        what brings the watcher back, and the watcher what brings them back.
        SIGKILL for the same reason as a lost host.
        """
        pid = self.worker_pid()
        if pid is None:
            raise RuntimeError(f"no watcher process holds {self.root}")
        os.kill(pid, signal.SIGKILL)
        return pid

    def await_sessions_gone(self, pids: set[int], timeout: float) -> None:
        """Until every one of these session hosts has exited.

        A session host is a child of its watcher and ends when its pipe to it
        closes. One that outlived its watcher would be a session nothing can
        reach, still holding its provider.
        """
        deadline = time.monotonic() + timeout
        while any(alive(pid) for pid in pids):
            if time.monotonic() >= deadline:
                survivors = sorted(pid for pid in pids if alive(pid))
                raise RuntimeError(
                    f"session host(s) {survivors} outlived their watcher by {timeout}s"
                )
            time.sleep(0.05)

    def stop_controller(self) -> set[int]:
        """Kill the controller outright, as a Console that is killed is lost.

        The supervisor and the watcher are sent SIGKILL, so nothing is written
        on the way out: the state a restart has to recover from is a stale
        owner record, a journal, placements on disk and whatever the server is
        still holding for the connection. The session hosts are not killed.
        They are the watcher's children and see their pipe close, which is
        what ends them when Console dies; returns their pids so the caller
        can see that they did.
        """
        sessions = self.session_pids()
        doomed = [pid for pid in self.process_tree() if pid not in sessions]
        for pid in sorted(doomed, reverse=True):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                continue
        deadline = time.monotonic() + 15.0
        while any(alive(pid) for pid in doomed):
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"{len([pid for pid in doomed if alive(pid)])} controller "
                    "process(es) survived SIGKILL, so whatever is started next "
                    "would be the agent's second controller rather than its only one"
                )
            time.sleep(0.05)
        return sessions

    def start_controller(self, bundle: Path) -> None:
        """Start a controller on this root again, after one was stopped.

        The state it starts from is whatever the last one left on disk, which
        after a kill includes its own owner record: reclaiming that is part of
        what a restart has to do. `bundle` is the build to start it from — the
        same one to restart the controller that was there, another to put the
        machine through the upgrade a user performs by updating the app over
        its own state.
        """
        superseded = self.supervisor_pid
        self.bundle = bundle
        _start_watcher(
            bundle=bundle,
            root=self.root,
            template_path=self.template_path,
            environment=self.environment,
        )
        self.supervisor_pid = _await_supervisor(self.root, superseded)


def _template(
    *,
    agent_id: str,
    credentials_path: Path,
    cwd: Path,
    connection_id: str,
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
        "roomConnection": {"connectionId": connection_id, "rooms": []},
        "execution": {
            "credentialsPath": str(credentials_path),
            "inheritEnv": [],
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
    environment: Mapping[str, str],
) -> Iterator[BenchWatcher]:
    """Start a watcher for one agent and stop its whole tree afterwards.

    It opens the connection Switch Console derives for the agent. `environment`
    is added to the one every process in the tree runs with, such as a park
    timeout for a scenario about sessions parking.
    """
    connection_id = controller_connection_id(agent_id)
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
            _template(
                agent_id=agent_id,
                credentials_path=credentials_path,
                cwd=home,
                connection_id=connection_id,
            )
        )
    )

    environment = {
        **os.environ,
        **environment,
        "HOME": str(home),
        "SWITCH_BENCH_TRACE": str(trace_path),
    }
    _start_watcher(
        bundle=bundle, root=root, template_path=template_path, environment=environment
    )
    watcher = BenchWatcher(
        root=root,
        home=home,
        trace_path=trace_path,
        bundle=bundle,
        connection_id=connection_id,
        template_path=template_path,
        environment=environment,
        supervisor_pid=_await_supervisor(root, None),
    )
    try:
        yield watcher
    finally:
        _terminate(watcher.process_tree)


def _start_watcher(
    *,
    bundle: Path,
    root: Path,
    template_path: Path,
    environment: Mapping[str, str],
) -> None:
    """Ask for a watcher on this root, whether or not one has run here before."""
    started = subprocess.run(
        ["node", str(bundle), str(root), str(template_path), "--ensure-watch"],
        capture_output=True,
        text=True,
        env=dict(environment),
        timeout=120,
    )
    if started.returncode != 0:
        raise RuntimeError(
            f"the benchmark watcher did not start.\n{started.stdout}\n{started.stderr}"
        )


def _await_supervisor(root: Path, superseded: int | None) -> int:
    """The pid of the detached supervisor that now owns this root.

    Read from its own owner record rather than from the process that launched
    it: that process spawns the supervisor detached and exits, so the
    supervisor is reparented and is not in the driver's process tree.

    `superseded` is the controller this one replaces, if there was one. A
    killed controller leaves its owner record behind, so without it the caller
    would be handed the pid of the process it has just killed.
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
            pid = int(json.loads(owner.read_text())["pid"])
            if pid != superseded:
                return pid
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
            living = sorted((pid for pid in known if alive(pid)), reverse=True)
            if not living:
                return
            for pid in living:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    continue
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
    remaining = [pid for pid in known if alive(pid)]
    if remaining:
        raise RuntimeError(
            f"{len(remaining)} benchmark host process(es) survived SIGKILL: "
            f"{sorted(remaining)}. Anything measured after this would be sharing "
            "the machine with a workload that was supposed to be over."
        )


def _owner(lock: Path) -> int | None:
    """The live process a lock file names, or None when there is none."""
    try:
        pid = int(json.loads(lock.read_text())["pid"])
    except FileNotFoundError:
        return None
    return pid if alive(pid) else None


def alive(pid: int) -> bool:
    """Whether a process with this pid exists."""
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
    them: a loss is a measurement to report beside the latency of what did
    arrive, not something that should throw that latency away.

    The caller decides what the loss means. Where every message is expected to
    arrive, the caller asserts the result is empty, so nothing is measured over
    a silently partial population.
    """
    outstanding = set(markers)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        outstanding -= dispatched(watcher, markers)
        if not outstanding:
            break
        time.sleep(0.05)
    return frozenset(markers[marker] for marker in outstanding)


def dispatched(watcher: BenchWatcher, markers: Mapping[str, str]) -> frozenset[str]:
    """Which of `markers` a provider has already been handed, read right now.

    Asked rather than waited for, so a scenario that interrupts a delivery can
    say whether it interrupted anything.
    """
    served = {
        record["correlation"] for record in host_records(watcher, PROVIDER_DISPATCH)
    }
    return frozenset(marker for marker in markers if marker in served)


def host_records(watcher: BenchWatcher, point: str) -> list[dict[str, Any]]:
    """Every record the watcher's hosts traced at `point`, in the order written."""
    return [
        record
        for line in watcher.trace_path.read_text().splitlines()
        if line.strip()
        for record in (json.loads(line),)
        if record["point"] == point
    ]
