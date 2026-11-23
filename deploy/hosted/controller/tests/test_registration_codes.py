"""A box gets a live registration code just before its first start, never a dead one, and spent codes don't
linger in its Secret. No cluster and no Core: stand-ins answer."""

import base64
import logging

import pytest

from switch_hosted_controller.box_scaler import CoreApi, CoreRefused, KubeApi, reconcile_once
from switch_hosted_controller.registration_codes import (
    ASK_INTERVAL_S,
    RETRY_AFTER_REFUSAL_S,
    WAIT_BEFORE_RESTART_S,
    RegistrationCodes,
)

M = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"
NS = "agents-user-b"
CODE = "swce_SECRET-code-value-0123456789"
BOXES = {M: NS}


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


def unregistered(*codes):
    return {
        "controllers": [
            {"key": f"w{i}", "id": None, "enrollment_code": c} for i, c in enumerate(codes)
        ]
    }


REGISTERED = {"controllers": [{"key": "w0", "id": "ctl-1", "enrollment_code": None}]}


class FakeCore:
    def __init__(self, desired="running", answer=None, fail=False):
        self.desired, self.answer, self.fail = desired, answer, fail
        self.asked, self.seen = [], []

    def machines(self):
        return [{"machine_id": M, "desired_state": self.desired, "revision": 1}]

    def observe(self, machine_id, state, revision, error=None):
        self.seen.append(state)

    def prepare(self, machine_id):
        self.asked.append(machine_id)
        if self.fail:
            raise RuntimeError("core down")
        return self.answer


class FakeKube:
    def __init__(self, replicas=0, ready=0, code=None):
        self.replicas, self.ready, self.code = replicas, ready, code
        self.calls = []

    def scale(self, ns):
        return self.replicas, self.ready

    def set_replicas(self, ns, n):
        self.calls.append(("scale", ns, n))
        self.replicas = n

    def enrol_code(self, ns):
        return self.code

    def set_enrol_code(self, ns, code):
        self.calls.append(("secret", ns, "written" if code else "emptied"))
        self.code = code


def codes_for(core, kube, clock=None, boxes=BOXES):
    return RegistrationCodes(core, kube, boxes, clock=clock or Clock())


# --- the first start ------------------------------------------------------------------------------------------------


def test_a_first_start_writes_the_code_then_starts_the_box(caplog):
    core, kube = FakeCore(answer=unregistered(CODE)), FakeKube(0, 0)
    with caplog.at_level(logging.DEBUG):
        reconcile_once(core, kube, BOXES, codes=codes_for(core, kube))
    assert kube.calls == [("secret", NS, "written"), ("scale", NS, 1)]
    assert kube.code == CODE
    assert core.asked == [M]
    assert CODE not in caplog.text  # ids and times only, never the code
    assert any(
        "registration code written for agents-user-b" in r.getMessage() for r in caplog.records
    )


def test_a_registered_box_gets_no_code_and_starts_as_before():
    core, kube = FakeCore(answer=REGISTERED), FakeKube(0, 0)
    reconcile_once(core, kube, BOXES, codes=codes_for(core, kube))
    assert kube.calls == [("scale", NS, 1)]


def test_a_failed_ask_still_starts_the_box(caplog):
    core, kube = FakeCore(fail=True), FakeKube(0, 0)
    with caplog.at_level(logging.WARNING):
        reconcile_once(core, kube, BOXES, codes=codes_for(core, kube))
    assert kube.calls == [("scale", NS, 1)]
    assert any(
        "could not ask Core for its registration code (RuntimeError)" in r.getMessage()
        for r in caplog.records
    )


def test_more_than_one_code_writes_nothing_and_starts_the_box():
    core, kube = FakeCore(answer=unregistered(CODE, "swce_another")), FakeKube(0, 0)
    reconcile_once(core, kube, BOXES, codes=codes_for(core, kube))
    assert kube.calls == [("scale", NS, 1)]


def test_without_codes_the_scaler_is_unchanged():
    core, kube = FakeCore(answer=unregistered(CODE)), FakeKube(0, 0)
    reconcile_once(core, kube, BOXES)
    assert kube.calls == [("scale", NS, 1)] and core.asked == []


def test_core_is_asked_at_most_once_per_box_every_five_minutes():
    clock = Clock()
    core, kube = FakeCore(answer=unregistered(CODE)), FakeKube(0, 0)
    codes = codes_for(core, kube, clock)
    codes.before_start(M, NS)
    codes.before_start(M, NS)
    assert core.asked == [M]
    clock.t += ASK_INTERVAL_S
    codes.before_start(M, NS)
    assert core.asked == [M, M]


def test_a_machine_outside_the_box_map_is_never_asked_for():
    core, kube = FakeCore(answer=unregistered(CODE)), FakeKube(0, 0)
    codes = codes_for(core, kube)
    codes.before_start(OTHER, NS)  # not in the map
    codes.before_start(M, "agents-user-someone-else")  # the map names another namespace
    assert core.asked == [] and kube.calls == []


# --- a box stuck with a dead code -----------------------------------------------------------------------------------


def test_a_box_stuck_with_a_dead_code_gets_the_new_one_and_is_restarted():
    clock = Clock()
    core = FakeCore(answer=unregistered("swce_fresh"))
    kube = FakeKube(1, 0, code="swce_dead")
    codes = codes_for(core, kube, clock)
    waiting = {M: clock.t}
    reconcile_once(core, kube, BOXES, waiting, now=clock, codes=codes)
    assert core.asked == []  # just started: give it time to register
    clock.t += WAIT_BEFORE_RESTART_S
    reconcile_once(core, kube, BOXES, waiting, now=clock, codes=codes)
    assert kube.calls == [("secret", NS, "written"), ("scale", NS, 0)]
    assert kube.code == "swce_fresh"
    # The next pass starts it again, as any stopped box Core wants running.
    clock.t += ASK_INTERVAL_S
    core.answer = unregistered("swce_fresh")
    reconcile_once(core, kube, BOXES, waiting, now=clock, codes=codes)
    assert kube.calls[-1] == ("scale", NS, 1)


def test_a_box_already_holding_the_live_code_is_left_to_register():
    clock = Clock()
    core = FakeCore(answer=unregistered(CODE))
    kube = FakeKube(1, 0, code=CODE)
    codes = codes_for(core, kube, clock)
    reconcile_once(core, kube, BOXES, {M: clock.t - WAIT_BEFORE_RESTART_S}, now=clock, codes=codes)
    assert kube.calls == []


# --- once registered ------------------------------------------------------------------------------------------------


def test_a_registered_box_s_secret_is_emptied_once():
    clock = Clock()
    core, kube = FakeCore(answer=REGISTERED), FakeKube(1, 1, code=CODE)
    codes = codes_for(core, kube, clock)
    reconcile_once(core, kube, BOXES, now=clock, codes=codes)
    assert kube.calls == [("secret", NS, "emptied")] and kube.code is None
    clock.t += ASK_INTERVAL_S
    reconcile_once(core, kube, BOXES, now=clock, codes=codes)
    assert core.asked == [M]  # not asked again this run


def test_a_ready_box_core_still_holds_a_code_for_is_not_emptied():
    core, kube = FakeCore(answer=unregistered(CODE)), FakeKube(1, 1, code=CODE)
    reconcile_once(core, kube, BOXES, codes=codes_for(core, kube))
    assert kube.calls == []


# --- the clients ----------------------------------------------------------------------------------------------------


class Recorder:
    def __init__(self, reply=None):
        self.calls, self.reply = [], reply if reply is not None else {}

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.reply


def _kube(reply=None):
    api = object.__new__(KubeApi)
    api._call = Recorder(reply)  # type: ignore[method-assign]
    return api


def test_the_secret_is_read_and_written_in_the_box_s_namespace_only():
    encoded = base64.b64encode(CODE.encode()).decode()
    api = _kube({"data": {"code": encoded}})
    assert api.enrol_code(NS) == CODE
    api.set_enrol_code(NS, CODE)
    api.set_enrol_code(NS, None)
    (get, write, empty) = api._call.calls  # type: ignore[attr-defined]
    path = f"/api/v1/namespaces/{NS}/secrets/switch-enrol"
    assert get == (("GET", path), {"timeout": 10.0})
    assert write == (
        ("PATCH", path, {"data": {"code": encoded, "registered": None}}),
        {"timeout": 10.0},
    )  # a new code takes the registered mark out
    mark = base64.b64encode(b"yes").decode()
    assert empty == (
        ("PATCH", path, {"data": {"code": None, "registered": mark}}),
        {"timeout": 10.0},
    )  # registered: the code goes, the mark comes
    assert _kube({"data": {}}).enrol_code(NS) is None
    for bad in ("kube-system", "agents-user-b/../x", ""):
        with pytest.raises(ValueError):
            _kube().set_enrol_code(bad, CODE)


def test_core_is_asked_by_machine_id_only():
    api = object.__new__(CoreApi)
    api._call = Recorder({"controllers": []})  # type: ignore[method-assign]
    assert api.prepare(M) == {"controllers": []}
    assert api._call.calls == [((f"/machines/{M}/prepare", {}), {})]  # type: ignore[attr-defined]
    with pytest.raises(ValueError):
        api.prepare("../machines")


def _apply(data: dict[str, str], patch: dict) -> None:
    """A strategic-merge PATCH of a Secret's `data`, as the API server applies it: None takes a key out."""
    for key, value in patch["data"].items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value


def _starter_exits(tmp_path, data: dict[str, str], wait_s: float) -> bool:
    """Runs the box's own starter script against the Secret's keys as the kubelet mounts them (one file per key,
    decoded), with the proxy login there. True when it exits within `wait_s`."""
    import subprocess
    import time

    from switch_hosted_controller.box_operator import STARTER_SCRIPT

    enrol, login = tmp_path / "enrol", tmp_path / "login"
    enrol.mkdir()
    login.mkdir()
    for key, value in data.items():
        (enrol / key).write_bytes(base64.b64decode(value))
    (login / "https_proxy").write_text("http://login@proxy:3128")
    script = STARTER_SCRIPT.replace("/etc/switch/enrol", str(enrol)).replace(
        "/etc/switch/login", str(login)
    )
    proc = subprocess.Popen(["sh", "-c", script], stdout=subprocess.PIPE, text=True)
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return proc.returncode == 0
        time.sleep(0.1)
    proc.kill()
    proc.wait()
    return False


def test_a_registered_box_starts_again_at_once(tmp_path):
    """A t2 box that has registered, then stops (idle, an eviction, a drain) and starts again: the scaler removed
    its code once it registered, and its starter still lets it start, on the `registered` mark."""
    data: dict[str, str] = {}
    api = _kube()
    api.set_enrol_code(NS, CODE)  # the first start's code
    api.set_enrol_code(NS, None)  # registered: the scaler removes it
    for (_method, _path, patch), _ in api._call.calls:  # type: ignore[attr-defined]
        _apply(data, patch)
    assert set(data) == {"registered"}  # no code kept
    assert _starter_exits(tmp_path, data, wait_s=5)


def test_a_box_with_neither_a_code_nor_the_mark_still_waits(tmp_path):
    """A pool box before its owner is written: an empty Secret, so its starter keeps waiting."""
    assert not _starter_exits(tmp_path, {}, wait_s=1.5)


def test_a_new_code_takes_the_mark_out(tmp_path):
    """A box whose registration was lost gets a new code: the mark goes, so the Secret says what's true."""
    data: dict[str, str] = {}
    api = _kube()
    api.set_enrol_code(NS, None)
    api.set_enrol_code(NS, CODE)
    for (_method, _path, patch), _ in api._call.calls:  # type: ignore[attr-defined]
        _apply(data, patch)
    assert set(data) == {"code"}
    assert _starter_exits(tmp_path, data, wait_s=5)


# --- a running box whose starter waits (a warm pool box just given to its owner) ---------------------------------


POOL_NS = "agents-box-k1-00000000000000aa"


def _pod(starter: str) -> dict:
    """The box's pod with its starter `running` (still waiting), `terminated` (done), or absent (template t1)."""
    statuses = [] if starter == "absent" else [{"name": "starter", "state": {starter: {}}}]
    return {"status": {"phase": "Pending", "initContainerStatuses": statuses}}


class PodKube(FakeKube):
    def __init__(self, starter="running", **kwargs):  # type: ignore[no-untyped-def]
        super().__init__(**kwargs)
        self.starter = starter

    def box_pods(self, ns):  # type: ignore[no-untyped-def]
        return [_pod(self.starter)]


class RefusingOnce(FakeCore):
    def __init__(self, **kwargs):  # type: ignore[no-untyped-def]
        super().__init__(**kwargs)
        self.refusals = 1

    def prepare(self, machine_id):  # type: ignore[no-untyped-def]
        if self.refusals:
            self.refusals -= 1
            self.asked.append(machine_id)
            raise CoreRefused("/machines/x/prepare", 409, "Conflict")
        return super().prepare(machine_id)


def _passes(core, kube, boxes, clock, until_s, step_s=2.0):  # type: ignore[no-untyped-def]
    codes, waiting = codes_for(core, kube, clock, boxes), {}
    start = clock.t
    while clock.t - start <= until_s:
        reconcile_once(core, kube, boxes, waiting=waiting, now=clock, codes=codes)
        clock.t += step_s
    return codes


@pytest.mark.parametrize("ns", [POOL_NS, NS])
def test_a_running_unregistered_box_gets_its_code_with_no_restart(ns, caplog):
    """Its starter is waiting and its Secret is empty: the code is written on the first pass, and the box is never
    stopped or started again while the starter picks it up, past the 90 s check too."""
    boxes, clock = {M: ns}, Clock()
    core, kube = FakeCore(answer=unregistered(CODE)), PodKube(replicas=1, ready=0)
    with caplog.at_level(logging.DEBUG):
        reconcile_once(
            core, kube, boxes, waiting={}, now=clock, codes=codes_for(core, kube, clock, boxes)
        )
    assert kube.calls == [("secret", ns, "written")] and kube.code == CODE
    clock2 = Clock()
    core2, kube2 = FakeCore(answer=unregistered(CODE)), PodKube(replicas=1, ready=0)
    _passes(core2, kube2, boxes, clock2, until_s=WAIT_BEFORE_RESTART_S + 30)
    assert kube2.calls == [("secret", ns, "written")]  # no ("scale", …): no restart
    assert core2.asked == [M]
    assert CODE not in caplog.text


def test_a_refused_ask_for_a_waiting_starter_is_tried_again_in_seconds():
    """A refusal (Core not ready to give a code yet) is asked again after 10 s, not 5 minutes, so the code still
    comes well inside the 3-minute start limit."""
    clock = Clock()
    core, kube = RefusingOnce(answer=unregistered(CODE)), PodKube(replicas=1, ready=0)
    _passes(core, kube, {M: POOL_NS}, clock, until_s=RETRY_AFTER_REFUSAL_S + 2)
    assert core.asked == [M, M]
    assert kube.calls == [("secret", POOL_NS, "written")]
    assert "error" not in core.seen


def test_a_waiting_starter_core_says_is_registered_gets_the_mark():
    """Registered already but with no mark (its Secret was emptied by an older scaler): marked, no restart."""
    clock = Clock()
    core, kube = FakeCore(answer=REGISTERED), PodKube(replicas=1, ready=0)
    _passes(core, kube, {M: POOL_NS}, clock, until_s=WAIT_BEFORE_RESTART_S + 10)
    assert kube.calls == [("secret", POOL_NS, "emptied")]  # the code out, the mark in
    assert core.asked == [M]


def test_a_waiting_starter_that_has_its_code_is_left_alone():
    clock = Clock()
    core, kube = FakeCore(answer=unregistered(CODE)), PodKube(replicas=1, ready=0, code=CODE)
    _passes(core, kube, {M: POOL_NS}, clock, until_s=WAIT_BEFORE_RESTART_S + 10)
    assert kube.calls == []


@pytest.mark.parametrize("starter", ["terminated", "absent"])
def test_a_box_not_in_its_starter_keeps_the_old_path(starter):
    """Past its starter, or a t1 box with none (it reads its code only at boot): not asked early, and after 90 s
    given a live code and restarted, exactly as before."""
    clock = Clock()
    core, kube = FakeCore(answer=unregistered(CODE)), PodKube(starter=starter, replicas=1, ready=0)
    asked_at = []
    plain = core.prepare
    core.prepare = lambda mid: (asked_at.append(clock.t - 1000.0), plain(mid))[1]  # type: ignore[method-assign]
    _passes(core, kube, {M: POOL_NS}, clock, until_s=WAIT_BEFORE_RESTART_S + 4)
    assert asked_at == [WAIT_BEFORE_RESTART_S]  # first asked at 90 s, not before
    assert kube.calls[:2] == [("secret", POOL_NS, "written"), ("scale", POOL_NS, 0)]


def test_the_scaler_looks_for_the_operator_s_starter_by_its_name():
    from switch_hosted_controller.box_operator import _starter
    from switch_hosted_controller.box_scaler import STARTER

    assert _starter.__code__.co_consts.count(STARTER) == 1
