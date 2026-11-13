import pytest

from switch_hosted_controller.box_scaler import CoreRefused, _observe, decide, reconcile_once, run

M = "11111111-1111-1111-1111-111111111111"
BOXES = {M: "agents-user-b"}


class FakeKube:
    def __init__(self, replicas=1, ready=1):
        self.replicas, self.ready, self.calls = replicas, ready, []

    def scale(self, ns):
        return self.replicas, self.ready

    def set_replicas(self, ns, n):
        self.calls.append((ns, n))
        self.replicas = n


class FakeCore:
    def __init__(self, machines):
        self._m, self.seen = machines, []

    def machines(self):
        return self._m

    def observe(self, machine_id, state, revision, error=None):
        self.seen.append(
            (machine_id, state, revision) if error is None else (machine_id, state, revision, error)
        )


def m(desired, rev=3, mid=M):
    return {"machine_id": mid, "desired_state": desired, "revision": rev, "state": "ready"}


def test_decide_table():
    assert decide("running", 0, 0) == ("scale_up", "provisioning")
    assert decide("running", 1, 0) == (None, "provisioning")
    assert decide("running", 1, 1) == (None, "running")
    assert decide("stopped", 1, 1) == ("scale_down", "stopping")
    assert decide("stopped", 0, 1) == (None, "stopping")
    assert decide("stopped", 0, 0) == (None, "stopped")


def test_idle_stop_scales_down_and_keeps_reporting():
    kube, core = FakeKube(1, 1), FakeCore([m("stopped")])
    reconcile_once(core, kube, BOXES)
    assert kube.calls == [("agents-user-b", 0)]
    assert core.seen == [(M, "stopping", 3)]


def test_wake_scales_up_once_even_when_called_repeatedly():
    kube, core = FakeKube(0, 0), FakeCore([m("running")])
    for _ in range(5):  # a burst of passes while the pod starts
        reconcile_once(core, kube, BOXES)
    assert kube.calls == [("agents-user-b", 1)]


def test_unmapped_and_invalid_machines_are_left_alone():
    kube = FakeKube(1, 1)
    core = FakeCore(
        [
            m("stopped", mid="22222222-2222-2222-2222-222222222222"),
            {"machine_id": M, "desired_state": "bogus", "revision": 1},
            {"machine_id": M, "desired_state": "stopped", "revision": "x"},
        ]
    )
    assert reconcile_once(core, kube, BOXES) == []
    assert kube.calls == [] and core.seen == []


def test_decide_scales_retained_and_deleted_to_zero_like_stopped():
    for desired in ("retained", "deleted"):
        assert decide(desired, 1, 1) == ("scale_down", "stopping")
        assert decide(desired, 1, 0) == ("scale_down", "stopping")
        assert decide(desired, 0, 1) == (None, "stopping")
        assert decide(desired, 0, 0) == (None, "stopped")


def test_retained_and_deleted_boxes_are_scaled_down_and_never_deleted():
    # A retained (agentless) or deleted box that is still up was left
    # running and reported as provisioning. It is scaled to 0 now, as a stopped
    # one is, and the scaler has no way to delete anything: FakeKube, like the
    # Kube it stands for, can only read and set replicas.
    for desired in ("retained", "deleted"):
        kube, core = FakeKube(1, 1), FakeCore([m(desired)])
        reconcile_once(core, kube, BOXES)
        assert kube.calls == [("agents-user-b", 0)]
        assert core.seen == [(M, "stopping", 3)]
        # The next pass sees it down: nothing more is done, and it reads stopped.
        kube.ready = 0
        reconcile_once(core, kube, BOXES)
        assert kube.calls == [("agents-user-b", 0)]
        assert core.seen[-1] == (M, "stopped", 3)


def test_retained_and_deleted_boxes_already_down_are_left_alone():
    for desired in ("retained", "deleted"):
        kube, core = FakeKube(0, 0), FakeCore([m(desired)])
        reconcile_once(core, kube, BOXES)
        assert kube.calls == []
        assert core.seen == [(M, "stopped", 3)]


def test_run_survives_a_failing_pass():
    class Boom(FakeCore):
        def machines(self):
            raise RuntimeError("core down")

    passes = []
    run(
        Boom([]), FakeKube(), BOXES, stop=lambda: len(passes) >= 2, sleep=lambda s: passes.append(s)
    )
    assert passes == [10.0, 10.0]


def _map(tmp_path, data, mode=0o600):
    p = tmp_path / "boxes.json"
    p.write_text(__import__("json").dumps(data))
    p.chmod(mode)
    return p


def test_box_map_validation(tmp_path):
    import pytest

    from switch_hosted_controller.box_scaler import ScalerConfigError, load_boxes

    assert load_boxes(_map(tmp_path, {M: "agents-user-b"})) == {M: "agents-user-b"}
    bad = [
        ({M: "kube-system"}, 0o600),
        ({M: "agents-user-B"}, 0o600),
        ({"not-a-uuid": "agents-user-b"}, 0o600),
        ({M: "agents-user-b", "22222222-2222-2222-2222-222222222222": "agents-user-b"}, 0o600),
        ({}, 0o600),
        ({M: "agents-user-b"}, 0o644),
    ]
    for data, mode in bad:
        with pytest.raises((ScalerConfigError, ValueError)):
            load_boxes(_map(tmp_path, data, mode))


def _mounted_map(tmp_path, data, mode=0o400):  # type: ignore[no-untyped-def]
    """Laid out as Kubernetes mounts a Secret: files under a hidden timestamped
    directory, `..data` linking to it, and each key a link through `..data`."""
    import os

    root = tmp_path / "box-map"
    real = root / "..2026_10_29_12_00_00.000000001"
    real.mkdir(parents=True)
    for key, value in data.items():
        (real / key).write_text(value)
        os.chmod(real / key, mode)
    os.symlink(real.name, root / "..data")
    for key in data:
        os.symlink(f"..data/{key}", root / key)
    return root


def test_the_mounted_box_map_secret_reads_one_box_per_file(tmp_path):
    import pytest

    from switch_hosted_controller.box_scaler import ScalerConfigError, load_boxes

    other = "22222222-2222-2222-2222-222222222222"
    ns = "agents-user-k1-0123456789abcdef"
    assert load_boxes(_mounted_map(tmp_path, {M: ns, other: ns + "x"})) == {
        M: ns,
        other: ns + "x",
    }
    # A new cluster starts with no boxes.
    assert load_boxes(_mounted_map(tmp_path / "empty", {})) == {}
    # As mounted with the pod's fsGroup: group read is fine.
    assert load_boxes(_mounted_map(tmp_path / "group", {M: ns}, 0o440)) == {M: ns}
    bad = [
        ({M: "kube-system"}, 0o400),
        ({"not-a-uuid": ns}, 0o400),
        ({M: ns, other: ns}, 0o400),
        ({M: ns}, 0o444),
        ({M: ns}, 0o460),
    ]
    for i, (data, mode) in enumerate(bad):
        with pytest.raises(ScalerConfigError):
            load_boxes(_mounted_map(tmp_path / f"bad{i}", data, mode))


def test_a_box_map_entry_pointing_outside_the_mount_is_refused(tmp_path):
    import os

    import pytest

    from switch_hosted_controller.box_scaler import ScalerConfigError, load_boxes

    outside = tmp_path / "elsewhere"
    outside.write_text("agents-user-k1-0123456789abcdef")
    os.chmod(outside, 0o400)
    root = tmp_path / "box-map"
    root.mkdir()
    os.symlink(outside, root / M)
    with pytest.raises(ScalerConfigError):
        load_boxes(root)


def test_core_origin_must_be_https_or_loopback():
    import pytest

    from switch_hosted_controller.box_scaler import ScalerConfigError, check_core_origin

    for ok in ("https://core.example", "http://127.0.0.1:8510", "http://localhost:8510"):
        assert check_core_origin(ok) == ok
    for bad in ("http://10.0.1.10", "http://core.example", "ftp://127.0.0.1"):
        with pytest.raises(ScalerConfigError):
            check_core_origin(bad)


def test_start_not_ready_after_3_minutes_is_reported_as_an_error():
    kube, core = FakeKube(0, 0), FakeCore([m("running")])
    clock, waiting = [1000.0], {}
    reconcile_once(core, kube, BOXES, waiting, now=lambda: clock[0])  # scale up
    clock[0] += 170
    reconcile_once(core, kube, BOXES, waiting, now=lambda: clock[0])  # still within 3 min
    assert core.seen[-1][1] == "provisioning"
    clock[0] += 20
    reconcile_once(core, kube, BOXES, waiting, now=lambda: clock[0])  # past 3 min
    assert core.seen[-1][1] == "error" and "3 minutes" in core.seen[-1][3]
    assert kube.calls == [("agents-user-b", 1)]  # never scaled twice
    kube.ready = 1
    reconcile_once(core, kube, BOXES, waiting, now=lambda: clock[0])
    assert core.seen[-1][1] == "running" and M not in waiting


class _Boxes:
    """Several boxes, each its own namespace and replica count."""

    def __init__(self, replicas):
        self.replicas, self.calls = dict(replicas), []

    def scale(self, ns):
        n = self.replicas[ns]
        return n, n

    def set_replicas(self, ns, n):
        self.calls.append((ns, n))
        self.replicas[ns] = n


class _RefusingCore:
    """Core with hosted agents v2 off: every box listed stopped, and every observation refused, as Core refuses v2's
    fields with a 422 then."""

    def __init__(self, machines):
        self._m, self.tried = machines, []

    def machines(self):
        return self._m

    def observe(self, machine_id, *args, **kwargs):
        self.tried.append(machine_id)
        raise CoreRefused(f"/machines/{machine_id}/observation", 422, "Unprocessable Entity")


A, B = "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"
TWO = {A: "agents-user-a", B: "agents-user-b2"}


def test_a_box_running_at_v2_off_reaches_zero_though_every_observation_is_refused(caplog):
    """With v2 off: Core wanted it stopped, but the first refused
    observation ended the pass, so the box listed after it stayed at 1."""
    kube = _Boxes({"agents-user-a": 0, "agents-user-b2": 1})
    core = _RefusingCore([m("stopped", mid=A), m("stopped", mid=B)])
    with caplog.at_level("WARNING"):
        reconcile_once(core, kube, TWO)
    assert kube.calls == [("agents-user-b2", 0)]
    assert core.tried == [A, B]  # each box was observed, neither stopped the pass
    assert "observation (CoreRefused); the pass goes on" in caplog.text
    assert "422" not in caplog.text  # by type only


def test_nothing_scales_up_while_every_box_reads_stopped():
    kube = _Boxes({"agents-user-a": 0, "agents-user-b2": 0})
    core = _RefusingCore([m("stopped", mid=A), m("stopped", mid=B)])
    for _ in range(3):
        reconcile_once(core, kube, TWO)
    assert kube.calls == []


class _BrokenKube(_Boxes):
    def scale(self, ns):
        if ns == "agents-user-a":
            raise OSError("the API server timed out")
        return super().scale(ns)


def test_a_box_whose_kubernetes_call_fails_leaves_the_others_to_their_step(caplog):
    kube = _BrokenKube({"agents-user-a": 1, "agents-user-b2": 1})
    core = _RefusingCore([m("stopped", mid=A), m("stopped", mid=B)])
    with caplog.at_level("WARNING"), pytest.raises(RuntimeError, match="1 box step"):
        reconcile_once(core, kube, TWO)  # the pass still reads as failed
    assert kube.calls == [("agents-user-b2", 0)]
    assert f"Machine {A}: its step failed this pass (OSError)" in caplog.text


class _Owed:
    def __init__(self):
        self.reported = []

    def __call__(self, machine_id, n):
        self.reported.append((machine_id, n))


class _V2OffCore:
    """Core with hosted agents v2 off: v2's observation fields are refused with a 422, upstream's are taken."""

    def __init__(self, status=422):
        self.status, self.calls = status, []

    def observe(self, machine_id, state, revision, error=None, **v2):
        self.calls.append(sorted(v2))
        if v2:
            raise CoreRefused(f"/machines/{machine_id}/observation", self.status, "refused")


def test_a_422_for_v2_s_fields_sends_the_observation_again_with_upstream_s_only():
    core, watch, facts = _V2OffCore(), type("W", (), {})(), type("F", (), {})()
    watch.reported, facts.reported = _Owed(), _Owed()
    _observe(core, M, "stopped", 3, None, 2, {"restarts": 1, "node": "n1"}, watch, facts)
    assert core.calls == [["evictions", "node", "restarts"], []]
    assert watch.reported.reported == [] and facts.reported.reported == []  # still owed


def test_any_other_refusal_is_not_sent_again_and_stays_with_that_box(caplog):
    core = _V2OffCore(status=503)
    with caplog.at_level("WARNING"):
        _observe(core, M, "stopped", 3, None, 2, {}, None, None)
    assert core.calls == [["evictions"]]
    assert "Core did not take its observation (CoreRefused)" in caplog.text
