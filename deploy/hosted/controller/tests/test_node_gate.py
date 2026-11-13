import re
import threading
import time

import pytest

from switch_hosted_controller.node_gate import (
    CheckRun,
    GateNode,
    Instance,
    NodeGate,
    check_namespaces,
    first_second_ok,
    imds_ok,
    instance_problems,
    kubelet_ok,
    ns_base,
    pods_problem,
    proxy_ok,
    runsc_ok,
)

N1 = "ip-10-0-2-86.eu-west-3.compute.internal"
N2 = "ip-10-0-4-156.eu-west-3.compute.internal"
N3 = "ip-10-0-5-138.eu-west-3.compute.internal"

GOOD_FIRST = "\n".join(
    [
        "DNS works from t=1.0s ; test server works from t=1.2s",
        "-- denied routes after policy attached --",
    ]
    + [f"t=2.00s  public route {i}           blocked(timeout)" for i in range(16)]
)
GOOD_KUBELET = "/pods <urlopen error refused>\n/healthz <urlopen error refused>\n/metrics <urlopen error refused>"
GOOD_IMDS = "IMDS refused (good)"
GOOD_PROXY = "\n".join(
    [f"ALLOW site{i} reached (HTTP 200)" for i in range(11)]
    + [f"DENY x{i} BLOCKED: t" for i in range(11)]
)
GOOD_RUNSC = "Linux 4.19.0-gvisor\nStarting gVisor..."


class FakeEc2:
    def __init__(self, bad=None):
        self.bad = bad or {}

    def instance_by_ip(self, ip):
        return self.bad.get(ip, Instance("required", 1, None, "subnet-0abc", "l3"))

    def l3_subnets(self):
        return {"subnet-0abc", "subnet-0def"}


class FakeKube:
    def __init__(
        self,
        nodes,
        job_seconds=0.2,
        bad_imds=(),
        extra_pod=(),
        leftovers=(),
        wrong_node=(),
        all_at_once=None,
    ):
        self.nodes = {n.name: n for n in nodes}
        self.job_seconds = job_seconds
        # A barrier every check waits at: it opens only once that many checks are running together.
        self.all_at_once = all_at_once
        self.bad_imds, self.extra_pod, self.wrong_node = (
            set(bad_imds),
            set(extra_pod),
            set(wrong_node),
        )
        self.existing = set(leftovers)
        self.created, self.deleted, self.untainted, self.markers = [], [], [], []
        self.lock = threading.Lock()
        self.active = {}  # node -> number of checks running now
        self.peak_machines = 0

    def gate_nodes(self):
        return list(self.nodes.values())

    def namespaces(self):
        return sorted(self.existing | {"agents-check", "agents-user-b", "kube-system"})

    def namespace_exists(self, name):
        return name in self.existing

    def run_check(self, node, namespace, check):
        with self.lock:
            assert namespace not in self.existing, "a check namespace was reused"
            self.existing.add(namespace)
            self.created.append(namespace)
            self.active[node.name] = self.active.get(node.name, 0) + 1
            self.peak_machines = max(self.peak_machines, sum(1 for v in self.active.values() if v))
        if self.all_at_once is not None:
            self.all_at_once.wait()  # BrokenBarrierError, so a failed check, if they never all run together
        time.sleep(self.job_seconds)
        with self.lock:
            self.active[node.name] -= 1
        ran_on = "elsewhere" if node.name in self.wrong_node else node.name
        if check == "gate1":
            imds = "IMDS reached (bad)" if node.name in self.bad_imds else GOOD_IMDS
            return [
                CheckRun(ran_on, "gvisor", GOOD_FIRST, True),
                CheckRun(ran_on, "gvisor", GOOD_KUBELET, True),
                CheckRun(ran_on, "gvisor", imds, True),
            ]
        if check == "proxy":
            return [CheckRun(ran_on, "gvisor", GOOD_PROXY, True)]
        return [CheckRun(ran_on, "gvisor", GOOD_RUNSC, True)]

    def delete_namespace(self, name):
        with self.lock:
            self.existing.discard(name)
            self.deleted.append(name)

    def pods_on(self, node):
        pods = [("kube-system", "DaemonSet")] * 5
        return pods + ([("agents-x", "StatefulSet")] if node in self.extra_pod else [])

    def mark_failed(self, node, namespace):
        with self.lock:
            self.existing.add(namespace)
            self.markers.append(namespace)

    def untaint(self, node):
        with self.lock:
            self.untainted.append(node)
            n = self.nodes[node]
            self.nodes[node] = GateNode(n.name, n.ready, False, n.internal_ip, n.ready_since)


def nodes(*names, ready=True):
    return [
        GateNode(n, ready, True, f"10.0.{i}.{i}", time.time() - 30) for i, n in enumerate(names, 1)
    ]


class Results:
    """The gate's `on_result`: keeps each result and wakes a waiter as each arrives. The gate calls it last, after
    the untaint, the namespace clean-up and the failed set, so a machine with a result is finished."""

    def __init__(self):
        self.items = []
        self._arrived = threading.Condition()

    def __call__(self, result):
        with self._arrived:
            self.items.append(result)
            self._arrived.notify_all()

    def wait_for(self, count, timeout):
        with self._arrived:
            return self._arrived.wait_for(lambda: len(self.items) >= count, timeout)

    def by_node(self):
        return {r.node: r for r in self.items}

    def __getitem__(self, i):
        return self.items[i]


def gate_for(kube, ec2=None, **options):
    results = Results()
    return NodeGate(kube, ec2 or FakeEc2(), on_result=results, **options), results


def run_until_done(gate, results, kube, timeout=60, shutdown=True):
    """Ticks, as the gate's loop does, until every machine that needed a check has its result. It waits on the
    results themselves, never on the gate's in-flight set or a clock: a machine leaves that set before its result
    is recorded, and a queued machine is only started by a later tick. The timeout only stops a broken gate
    hanging the run."""
    expected = sum(1 for n in kube.gate_nodes() if n.ready and n.tainted)
    deadline = time.monotonic() + timeout
    gate.tick()
    while not results.wait_for(expected, 0.02):
        assert time.monotonic() < deadline, f"only {len(results.items)} of {expected} results"
        gate.tick()
    if shutdown:
        gate.shutdown()


# ---- names ----


def test_names_are_safe_distinct_and_short():
    names = [N1, "IP_10.0.2.86", "x" * 80 + ".y", "ip-10-0-2-86.other", "a..b--c", "...."]
    bases = [ns_base(n) for n in names]
    assert len(set(bases)) == len(bases)
    for b in bases:
        assert re.fullmatch(r"agents-check-[a-z0-9]([a-z0-9-]*[a-z0-9])?", b)
        assert len(b) + 3 <= 63
    assert check_namespaces(N1) == [f"{ns_base(N1)}-{s}" for s in ("g1", "px", "rs")]


# ---- reading each check ----


def test_each_reader_passes_good_output_and_names_a_bad_one():
    assert first_second_ok(GOOD_FIRST) is None
    assert "test server" in first_second_ok(GOOD_FIRST.replace("test server works from", "nothing"))
    assert "15 of 16" in first_second_ok(GOOD_FIRST.replace("blocked(timeout)", "OPEN", 1))
    assert kubelet_ok(GOOD_KUBELET) is None
    assert kubelet_ok(GOOD_KUBELET.replace("<urlopen error refused>", "200 ok", 1))
    assert imds_ok(GOOD_IMDS) is None and imds_ok("IMDS reached")
    assert proxy_ok(GOOD_PROXY) is None
    assert proxy_ok(GOOD_PROXY.replace("BLOCKED", "reached", 1))
    assert proxy_ok("\n".join(GOOD_PROXY.splitlines()[:21]))
    assert runsc_ok(CheckRun(N1, "gvisor", GOOD_RUNSC, True), N1) is None
    assert runsc_ok(CheckRun(N1, "runc", GOOD_RUNSC, True), N1)
    assert runsc_ok(CheckRun(N1, "gvisor", "Linux 6.1", True), N1)
    assert runsc_ok(
        CheckRun(N1, "gvisor", "Linux 6.1\nnot gVisor, honest", True), N1
    )  # a mention isn't dmesg's line
    assert imds_ok(
        "IMDSv2 TOKEN OBTAINED (BAD): 56 bytes\nIMDSv2 token refused (good): x"
    )  # any (BAD) fails


def test_instance_and_pod_checks():
    ok = Instance("required", 1, None, "subnet-0abc", "l3")
    assert instance_problems(ok, {"subnet-0abc"}) == []
    assert instance_problems(None, {"subnet-0abc"})
    assert instance_problems(Instance("optional", 1, None, "subnet-0abc", "l3"), {"subnet-0abc"})
    assert instance_problems(Instance("required", 2, None, "subnet-0abc", "l3"), {"subnet-0abc"})
    assert instance_problems(
        Instance("required", 1, "1.2.3.4", "subnet-0abc", "l3"), {"subnet-0abc"}
    )
    assert instance_problems(Instance("required", 1, None, "subnet-0abc", "l2"), {"subnet-0abc"})
    assert instance_problems(Instance("required", 1, None, "subnet-0zzz", "l3"), {"subnet-0abc"})
    assert instance_problems(
        Instance("required", 1, None, "", "l3"), {""}
    )  # an empty subnet never matches
    assert pods_problem([("kube-system", "DaemonSet")] * 5) is None
    assert pods_problem([("kube-system", "DaemonSet")] * 4)
    assert pods_problem([("kube-system", "DaemonSet")] * 5 + [("agents-x", "StatefulSet")])


# ---- the gate ----


def test_three_machines_pass_in_parallel_and_are_untainted_with_nothing_left():
    # 3 machines x 3 checks, all running at once: the barrier opens only when all 9 are waiting at it.
    kube = FakeKube(nodes(N1, N2, N3), job_seconds=0, all_at_once=threading.Barrier(9, timeout=30))
    gate, results = gate_for(kube, max_parallel=4)
    run_until_done(gate, results, kube)
    assert all(r.passed for r in results.items)
    assert sorted(kube.untainted) == sorted([N1, N2, N3])
    assert kube.existing == set()
    assert kube.peak_machines == 3


def test_the_limit_on_parallel_machines_holds():
    kube = FakeKube(nodes(N1, N2, N3), job_seconds=0.3)
    gate, results = gate_for(kube, max_parallel=1)
    run_until_done(gate, results, kube)
    assert kube.peak_machines == 1
    assert sorted(kube.untainted) == sorted([N1, N2, N3])


def test_a_bad_machine_stays_tainted_and_is_not_retried_while_the_others_pass():
    kube = FakeKube(nodes(N1, N2, N3), bad_imds={N2})
    gate, results = gate_for(kube)
    run_until_done(gate, results, kube, shutdown=False)
    assert sorted(kube.untainted) == sorted([N1, N3])
    failed = [r for r in results.items if not r.passed]
    assert [r.node for r in failed] == [N2] and "IMDS not refused" in failed[0].problems[0]
    assert kube.existing == {f"{ns_base(N2)}-g1"}  # kept as the failure marker; px and rs deleted
    before = len(kube.created)
    assert gate.tick() == []  # N2 is never started again by itself
    assert len(kube.created) == before
    gate.shutdown()


def test_an_instance_problem_stops_before_any_check_job():
    kube = FakeKube(nodes(N1))
    ec2 = FakeEc2(bad={"10.0.1.1": Instance("required", 1, "3.3.3.3", "subnet-0abc", "l3")})
    gate, results = gate_for(kube, ec2)
    run_until_done(gate, results, kube)
    assert kube.untainted == [] and kube.created == []
    assert "public address" in results[0].problems[0]
    assert kube.markers == [
        f"{ns_base(N1)}-g1"
    ]  # no check got that far, so an empty marker is made


def test_a_stray_pod_or_a_job_on_another_machine_fails_it():
    kube = FakeKube(nodes(N1, N2), extra_pod={N1}, wrong_node={N2})
    gate, collected = gate_for(kube)
    run_until_done(gate, collected, kube)
    results = collected.by_node()
    assert kube.untainted == []
    assert "other" in results[N1].problems[0]
    assert "another machine" in results[N2].problems[0]


def test_a_check_that_breaks_fails_the_machine_and_still_deletes_its_namespaces():
    kube = FakeKube(nodes(N1))

    def boom(node, namespace, check):
        kube.existing.add(namespace)
        raise RuntimeError("api down")

    kube.run_check = boom
    gate, results = gate_for(kube)
    run_until_done(gate, results, kube)
    assert kube.untainted == [] and not results[0].passed
    assert kube.existing == {f"{ns_base(N1)}-g1"}


def test_a_leftover_refuses_only_its_machine_and_is_kept():
    left = f"{ns_base(N3)}-px"
    kube = FakeKube(nodes(N1, N2, N3), leftovers={left})
    gate, collected = gate_for(kube)
    run_until_done(gate, collected, kube)
    results = collected.by_node()
    assert sorted(kube.untainted) == sorted([N1, N2])
    assert left in kube.existing
    assert "leftover" in results[N3].problems[0]


def test_the_sweep_deletes_only_gone_or_untainted_machines_leftovers():
    gone = "agents-check-ip-10-0-9-9-abcdef-rs"
    untainted = GateNode(N2, True, False, "10.0.2.2")
    kept = f"{ns_base(N1)}-g1"
    kube = FakeKube([nodes(N1)[0], untainted], leftovers={gone, kept, f"{ns_base(N2)}-g1"})
    gate = NodeGate(kube, FakeEc2())
    gate.sweep()
    assert gone not in kube.existing
    assert f"{ns_base(N2)}-g1" not in kube.existing
    assert kept in kube.existing
    assert "agents-check" not in kube.deleted and "agents-user-b" not in kube.deleted


def test_a_machine_not_ready_or_already_untainted_is_left_alone():
    kube = FakeKube([GateNode(N1, False, True, "10.0.1.1"), GateNode(N2, True, False, "10.0.2.2")])
    gate = NodeGate(kube, FakeEc2())
    assert gate.tick() == []
    gate.shutdown()


def test_max_parallel_is_bounded():
    with pytest.raises(ValueError):
        NodeGate(FakeKube([]), FakeEc2(), max_parallel=0)
    with pytest.raises(ValueError):
        NodeGate(FakeKube([]), FakeEc2(), max_parallel=17)


def test_a_failure_says_which_namespace_a_person_deletes_to_allow_a_retry(caplog):
    kube = FakeKube(nodes(N2), bad_imds={N2})
    with caplog.at_level("WARNING"):
        run_until_done(*gate_for(kube), kube)
    assert f"A person deletes namespace {ns_base(N2)}-g1 to allow a retry" in caplog.text


def test_a_failed_machine_is_not_checked_again_after_a_gate_restart():
    kube = FakeKube(nodes(N1, N2), bad_imds={N2})
    run_until_done(*gate_for(kube), kube)
    assert kube.untainted == [N1]
    runs_before = len(kube.created)
    restarted, results = gate_for(kube)  # a new gate pod: nothing in memory
    run_until_done(restarted, results, kube)
    assert len(kube.created) == runs_before  # N2's checks never ran again
    assert [r.node for r in results.items] == [N2] and "leftover" in results[0].problems[0]
    assert f"{ns_base(N2)}-g1" in kube.existing  # the sweep kept it: N2 still carries the taint


def test_a_pass_leaves_nothing_behind():
    kube = FakeKube(nodes(N1))
    run_until_done(*gate_for(kube), kube)
    assert kube.untainted == [N1] and kube.existing == set() and kube.markers == []
