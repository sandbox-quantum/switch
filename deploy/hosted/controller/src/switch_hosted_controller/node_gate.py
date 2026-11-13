"""The node gate: checks each new agents machine inside the cluster before any box may land on it (before real users).

New l3 pool machines come up carrying the `switch.dev/gate1` taint, so no box can be scheduled on them. Until now a
watcher on one person's Mac, with their AWS role, checked each one and removed the taint. That stops the cluster
growing whenever the Mac is off, and uses a person's broad role for a narrow job. This does the same checks from
inside the cluster, under its own narrow identity (design note
approved by security with five additions).

For each machine that is Ready, labelled `switch.dev/level=l3` and still tainted:

1. The instance, read from EC2: IMDS tokens required with a hop limit of 1, no public address, the `switch:level=l3`
   tag, and a subnet that is one of the l3 node subnets.
2. Three checks at once, each a Job pinned to the machine in a namespace of its own (`agents-check-<host>-<hash6>-
   g1|px|rs`): gate 1 (16 denied routes, the kubelet refused, IMDS refused from a pod), the proxy's allow and deny
   list against a fixed in-cluster target (never a user's box), and the gVisor proof.
3. Once all three have finished: nothing but the expected DaemonSet pods on the machine.
4. Only when every check passed is the taint removed. A failure keeps the taint, is logged once with ids and check
   names only, and is never retried by itself: a person looks.

Up to `max_parallel` machines are checked at once. Each machine's namespaces are deleted on every outcome. At start,
namespaces a stopped gate left behind are swept, unless their machine still carries the taint, in which case that
machine's check refuses until a person looks. If the gate is down, machines stay tainted: it fails closed.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Protocol

logger = logging.getLogger(__name__)

LEVEL_LABEL = "switch.dev/level"
LEVEL_L3 = "l3"
CHECK_PREFIX = "agents-check-"
STEPS = ("g1", "px", "rs")
CHECK_NAMESPACE_RE = re.compile(r"agents-check-[a-z0-9]([a-z0-9-]*[a-z0-9])?-(g1|px|rs)")
EXPECTED_DAEMONSETS = (
    5  # aws-node, kube-proxy, ebs-csi-node, eks-pod-identity-agent, aws-guardduty-agent
)
DENIED_ROUTES = 16
PROXY_LINES = 22


def ns_base(node: str) -> str:
    """A machine's check namespaces are `<base>-g1|px|rs`: its host name made safe (lower case, `[a-z0-9-]`), cut
    to fit, and 6 hex characters of its full name's hash so two machines never share one."""
    host = node.split(".", 1)[0].lower()
    safe = re.sub(r"-+", "-", re.sub(r"[^a-z0-9-]", "-", host)).strip("-")[:36].strip("-")
    digest = hashlib.sha256(node.encode()).hexdigest()[:6]
    return f"{CHECK_PREFIX}{safe}-{digest}" if safe else f"{CHECK_PREFIX}{digest}"


def check_namespaces(node: str) -> list[str]:
    base = ns_base(node)
    return [f"{base}-{step}" for step in STEPS]


# ---- what the cluster and EC2 are asked ----


@dataclass(frozen=True)
class GateNode:
    name: str
    ready: bool
    tainted: bool  # still carries the gate-1 taint
    internal_ip: str
    ready_since: float | None = None  # epoch seconds of the Ready transition


@dataclass(frozen=True)
class Instance:
    http_tokens: str
    hop_limit: int
    public_ip: str | None
    subnet_id: str
    level_tag: str | None


@dataclass(frozen=True)
class CheckRun:
    """What one check Job did: the machine its pod ran on, the runtime class it ran under, and its logs."""

    ran_on: str
    runtime: str
    logs: str
    completed: bool


class GateKube(Protocol):
    def gate_nodes(self) -> list[GateNode]: ...  # every node labelled switch.dev/level=l3
    def namespaces(self) -> list[str]: ...  # names only
    def namespace_exists(self, name: str) -> bool: ...
    def run_check(
        self, node: GateNode, namespace: str, check: str
    ) -> list[CheckRun]: ...  # creates, waits
    def delete_namespace(self, name: str) -> None: ...  # never waits
    def pods_on(
        self, node: str
    ) -> list[tuple[str, str]]: ...  # (namespace, owner kind) of unfinished pods
    def untaint(self, node: str) -> None: ...  # removes switch.dev/gate1 only
    def mark_failed(
        self, node: GateNode, namespace: str
    ) -> None: ...  # an empty check namespace, as a marker


class GateEc2(Protocol):
    def instance_by_ip(self, ip: str) -> Instance | None: ...
    def l3_subnets(self) -> set[str]: ...


# ---- reading each check's output (as the watcher scripts did) ----


def first_second_ok(logs: str) -> str | None:
    """Gate 1's routes: all 16 denied routes blocked after the policy attached, and the test server reached."""
    if "test server works from" not in logs:
        return "test server not reached"
    after = logs.split("denied routes after policy attached", 1)
    if len(after) < 2:
        return "no denied-routes section"
    lines = [
        line
        for line in after[1].splitlines()
        if re.match(r"^t=.*(public|IMDS|own node|Pod Identity)", line)
    ]
    blocked = [line for line in lines if "blocked(" in line]
    if len(lines) != DENIED_ROUTES or len(blocked) != DENIED_ROUTES:
        return f"denied routes: {len(blocked)} of {len(lines)} blocked, {DENIED_ROUTES} expected"
    return None


def kubelet_ok(logs: str) -> str | None:
    tried = [line for line in logs.splitlines() if re.match(r"^/(pods|healthz|metrics) ", line)]
    refused = [line for line in tried if re.match(r"^/(pods|healthz|metrics) <urlopen error", line)]
    return (
        None
        if len(tried) == 3 and len(refused) == 3
        else f"kubelet: {len(refused)} of {len(tried)} refused"
    )


def imds_ok(logs: str) -> str | None:
    if "(BAD)" in logs:
        return "IMDS gave a pod something (a (BAD) line)"
    return None if "refused (good)" in logs else "IMDS not refused from a pod"


def proxy_ok(logs: str, expected: int = PROXY_LINES) -> str | None:
    lines = [line for line in logs.splitlines() if line.strip()]
    bad = 0
    for line in lines:
        if line.startswith("ALLOW"):
            bad += "reached (HTTP " not in line
        elif line.startswith("DENY"):
            bad += "BLOCKED" not in line
        else:
            bad += 1
    if len(lines) != expected or bad:
        return (
            f"proxy: {len(lines)} lines, {bad} mismatches ({expected} lines, 0 mismatches expected)"
        )
    return None


def runsc_ok(run: CheckRun, node: str) -> str | None:
    if run.ran_on != node or run.runtime != "gvisor":
        return "gVisor proof did not run on the machine under gVisor"
    # dmesg's own line, not any mention of the word
    started = any(line.strip().startswith("Starting gVisor") for line in run.logs.splitlines())
    return None if started else "gVisor proof: no 'Starting gVisor' line in dmesg"


def instance_problems(instance: Instance | None, l3_subnets: set[str]) -> list[str]:
    if instance is None:
        return ["no instance found for the machine's address"]
    problems = []
    if instance.http_tokens != "required" or instance.hop_limit != 1:
        problems.append("IMDS is not tokens-required with hop limit 1")
    if instance.public_ip:
        problems.append("the instance has a public address")
    if instance.level_tag != LEVEL_L3:
        problems.append("the instance is not tagged switch:level=l3")
    if (
        not re.fullmatch(r"subnet-[0-9a-f]+", instance.subnet_id or "")
        or instance.subnet_id not in l3_subnets
    ):
        problems.append("the instance is not in an L3 node subnet")
    return problems


def pods_problem(pods: list[tuple[str, str]]) -> str | None:
    others = [ns for ns, kind in pods if kind != "DaemonSet"]
    daemonsets = sum(1 for _, kind in pods if kind == "DaemonSet")
    if others or daemonsets != EXPECTED_DAEMONSETS:
        return f"pods on the machine: {daemonsets} DaemonSet, {len(others)} other ({EXPECTED_DAEMONSETS} DaemonSet, 0 other expected)"
    return None


# ---- the gate ----


@dataclass
class GateResult:
    node: str
    passed: bool
    problems: list[str] = field(default_factory=list)
    took_s: float = 0.0
    from_ready_s: float | None = None


class NodeGate:
    """Call `tick` every few seconds. It sweeps leftovers once, then starts a check for each machine that needs one,
    up to `max_parallel` at a time, and returns at once: checks run on their own threads."""

    def __init__(
        self,
        kube: GateKube,
        ec2: GateEc2,
        max_parallel: int = 4,
        clock: Callable[[], float] = time.time,
        on_result: Callable[[GateResult], None] | None = None,
        proxy_lines: int = PROXY_LINES,
    ):
        if not 1 <= max_parallel <= 16:
            raise ValueError("max_parallel must be 1 to 16")
        self._kube, self._ec2, self._clock = kube, ec2, clock
        self._max = max_parallel
        self._pool = ThreadPoolExecutor(max_workers=max_parallel, thread_name_prefix="node-gate")
        self._lock = threading.Lock()
        self._inflight: set[str] = set()
        self._failed: set[str] = set()  # never retried by themselves
        self._swept = False
        self._on_result = on_result
        self._proxy_lines = proxy_lines

    def shutdown(self) -> None:
        self._pool.shutdown(wait=True)

    def sweep(self) -> None:
        """Delete check namespaces whose machine is gone or already untainted; keep a still-tainted machine's."""
        tainted = {ns_base(n.name) for n in self._kube.gate_nodes() if n.tainted}
        for ns in self._kube.namespaces():
            if not CHECK_NAMESPACE_RE.fullmatch(ns):
                continue  # never anything else, and never the old watcher's agents-check
            if ns.rsplit("-", 1)[0] in tainted:
                logger.warning(
                    "Node gate: kept leftover %s, its machine still carries the gate taint", ns
                )
                continue
            self._kube.delete_namespace(ns)
            logger.info("Node gate: deleted leftover %s", ns)

    def tick(self) -> list[str]:
        """Starts checks; returns the machines it started."""
        if not self._swept:
            self.sweep()
            self._swept = True
        started = []
        for node in self._kube.gate_nodes():
            if not (node.ready and node.tainted):
                continue
            with self._lock:
                if (
                    node.name in self._inflight
                    or node.name in self._failed
                    or len(self._inflight) >= self._max
                ):
                    continue
                self._inflight.add(node.name)
            self._pool.submit(self._check_and_record, node)
            started.append(node.name)
        return started

    def _check_and_record(self, node: GateNode) -> GateResult:
        try:
            result = self.check(node)
        except Exception as error:  # a check that breaks is a failed check: the taint stays
            result = GateResult(node.name, False, [f"the check broke ({type(error).__name__})"])
        with self._lock:
            self._inflight.discard(node.name)
            if not result.passed:
                self._failed.add(node.name)
        if result.passed:
            logger.info(
                "Node gate: PASS %s in %.0f s (%s s from Ready); untainted",
                node.name,
                result.took_s,
                "?" if result.from_ready_s is None else f"{result.from_ready_s:.0f}",
            )
        else:
            logger.warning(
                "Node gate: FAIL %s in %.0f s; taint stays, not retried: %s. "
                "A person deletes namespace %s to allow a retry.",
                node.name,
                result.took_s,
                "; ".join(result.problems),
                check_namespaces(node.name)[0],
            )
        if self._on_result:
            try:
                self._on_result(result)
            except Exception:
                logger.exception("Node gate: recording a result failed")
        return result

    def check(self, node: GateNode) -> GateResult:
        """One machine, start to finish. On a pass its namespaces are all deleted. On any failure its `-g1` namespace
        stays (made empty if no check got that far) as a marker: the leftover rule then stops the machine being
        checked again, across gate restarts too, until a person deletes it. A leftover that
        stopped a check is left for a person as well."""
        t0 = self._clock()
        namespaces = check_namespaces(node.name)
        leftovers = [ns for ns in namespaces if self._kube.namespace_exists(ns)]
        if leftovers:
            return GateResult(
                node.name, False, [f"leftover namespace {leftovers[0]}; a person looks"], 0.0
            )
        problems: list[str] = []
        untainted = False
        try:
            problems += instance_problems(
                self._ec2.instance_by_ip(node.internal_ip), self._ec2.l3_subnets()
            )
            if not problems:
                problems += self._three_checks(node, namespaces)
            pods = pods_problem(self._kube.pods_on(node.name))
            if pods:
                problems.append(pods)
            if not problems:
                self._kube.untaint(node.name)
                untainted = True
        finally:
            marker = None if untainted else namespaces[0]
            for ns in namespaces:
                if ns == marker:
                    continue
                try:
                    self._kube.delete_namespace(ns)
                except Exception:
                    logger.warning("Node gate: could not delete %s; the next start sweeps it", ns)
            if marker is not None:
                try:
                    if not self._kube.namespace_exists(marker):
                        self._kube.mark_failed(node, marker)
                except Exception:
                    logger.error(
                        "Node gate: could not keep the failure marker %s; a gate restart may check %s again",
                        marker,
                        node.name,
                    )
        now = self._clock()
        return GateResult(
            node.name,
            not problems,
            problems,
            now - t0,
            None if node.ready_since is None else now - node.ready_since,
        )

    def _three_checks(self, node: GateNode, namespaces: list[str]) -> list[str]:
        g1, px, rs = namespaces
        with ThreadPoolExecutor(max_workers=3) as checks:
            gate1 = checks.submit(self._kube.run_check, node, g1, "gate1")
            proxy = checks.submit(self._kube.run_check, node, px, "proxy")
            proof = checks.submit(self._kube.run_check, node, rs, "runsc")
            outcomes = {"gate 1": gate1, "proxy": proxy, "gVisor proof": proof}
            results: dict[str, list[CheckRun] | Exception] = {}
            for name, future in outcomes.items():
                try:
                    results[name] = future.result()
                except Exception as error:
                    results[name] = error
        problems: list[str] = []
        runs_by: dict[str, list[CheckRun]] = {}
        for name, runs in results.items():
            if isinstance(runs, Exception):
                problems.append(f"{name} broke ({type(runs).__name__})")
                continue
            runs_by[name] = runs
            for run in runs:
                if not run.completed:
                    problems.append(f"{name}: a check Job did not complete")
                elif run.ran_on != node.name:
                    problems.append(f"{name}: a check Job ran on another machine")
        if problems:
            return problems
        if (
            len(runs_by["gate 1"]) != 3
            or len(runs_by["proxy"]) != 1
            or len(runs_by["gVisor proof"]) != 1
        ):
            return ["a check returned the wrong number of Jobs"]
        first, kubelet, imds = runs_by["gate 1"]  # in the order gate 1 runs them
        for problem in (
            first_second_ok(first.logs),
            kubelet_ok(kubelet.logs),
            imds_ok(imds.logs),
            proxy_ok(runs_by["proxy"][0].logs, self._proxy_lines),
            runsc_ok(runs_by["gVisor proof"][0], node.name),
        ):
            if problem:
                problems.append(problem)
        return problems
