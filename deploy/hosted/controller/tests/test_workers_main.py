"""`switch-hosted-workers`: the mounts, the switches, and one worker failing."""

from __future__ import annotations

import io
import json
import logging
import threading
from pathlib import Path
from typing import Any

import pytest

from switch_hosted_controller import box_scaler, restart_actions, workers_main
from switch_hosted_controller.workers_main import (
    FreshCore,
    InClusterKubeApi,
    InClusterRestartKubeApi,
    Workers,
    WorkersConfigError,
    build,
    check_core_url,
    core_tls_context,
    in_cluster_server,
    interval_from_env,
    main,
    switches_from_env,
)

M1 = "11111111-1111-1111-1111-111111111111"
M2 = "22222222-2222-2222-2222-222222222222"
A1 = "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f"
NS1 = "agents-user-k1-0123456789abcdef"
NS2 = "agents-user-k1-fedcba9876543210"
TOKEN = "TOKEN-CANARY-3f9a-never-logged"
URL = "https://core.example.invalid"
ALL_ON = {
    "SWITCH_HOSTED_WORKERS_SCALER": "1",
    "SWITCH_HOSTED_WORKERS_EVICTIONS": "1",
    "SWITCH_HOSTED_WORKERS_CLUSTER_REPORT": "1",
    "SWITCH_HOSTED_WORKERS_RESTART": "1",
    "SWITCH_CLUSTER_PROXY_NAMESPACE": "switch-egress",
    "SWITCH_CLUSTER_OPERATOR_NAMESPACE": "switch-hosted",
}
SCALER = {"SWITCH_HOSTED_WORKERS_SCALER": "1"}
SCALER_AND_EVICTIONS = {**SCALER, "SWITCH_HOSTED_WORKERS_EVICTIONS": "1"}


def _write(path: Path, text: str, mode: int = 0o600) -> Path:
    path.write_text(text)
    path.chmod(mode)
    return path


def _box_map(tmp_path: Path, boxes: dict[str, str]) -> Path:
    """The `box-map` Secret as Kubernetes mounts it for an fsGroup pod: one 0440 file per
    machine id, through the hidden `..data` link."""
    root = tmp_path / "box-map"
    if root.exists():  # a new version of the Secret: Kubernetes swaps the links
        for entry in root.iterdir():
            if entry.is_symlink():
                entry.unlink()
    real = root / "..2026_10_29_16_00_00.000000001"
    real.mkdir(parents=True, exist_ok=True)
    for old in real.iterdir():
        old.unlink()
    for machine_id, namespace in boxes.items():
        _write(real / machine_id, namespace, 0o440)
    (root / "..data").symlink_to(real.name)
    for machine_id in boxes:
        (root / machine_id).symlink_to(f"..data/{machine_id}")
    return root


def _pod(uid: str, restarts: int = 0, node: str = "ip-10-0-1-7") -> dict[str, Any]:
    return {
        "metadata": {"name": "box-0", "uid": uid, "labels": {"app": "box"}},
        "spec": {"nodeName": node},
        "status": {"phase": "Running", "containerStatuses": [{"restartCount": restarts}]},
    }


class FakeCore:
    def __init__(self, machines: list[dict[str, Any]] | None = None):
        self.listed = machines or []
        self.observed: list[tuple[str, dict[str, Any]]] = []
        self.reports: list[dict[str, Any]] = []
        self.fail_machines: Exception | None = None
        self.codes: dict[str, str] = {}  # machine id -> its live one-time code
        self.prepared: list[str] = []

    def prepare(self, machine_id: str) -> dict[str, Any]:
        self.prepared.append(machine_id)
        code = self.codes.get(machine_id)
        return {"controllers": [{"enrollment_code": code} if code else {}]}

    def machines(self) -> list[dict[str, Any]]:
        if self.fail_machines is not None:
            raise self.fail_machines
        return self.listed

    def observe(self, machine_id: str, state: str, revision: int, error=None, **extra) -> None:  # type: ignore[no-untyped-def]
        self.observed.append((machine_id, {"state": state, **extra}))

    def report_cluster(self, report: dict[str, Any]) -> None:
        self.reports.append(report)


class FakeKube:
    def __init__(self) -> None:
        self.pods: dict[str, list[dict[str, Any]]] = {}
        self.looked: list[str] = []
        self.replicas: dict[str, int] = {}
        self.secret: dict[str, str | None] = {}
        self.order: list[str] = []

    def enrol_code(self, namespace: str) -> str | None:
        return self.secret.get(namespace)

    def set_enrol_code(self, namespace: str, code: str | None) -> None:
        self.order.append("code" if code else "empty")
        self.secret[namespace] = code

    def scale(self, namespace: str) -> tuple[int, int]:
        n = self.replicas.get(namespace, 1)
        return n, n

    def set_replicas(self, namespace: str, replicas: int) -> None:
        self.order.append(f"replicas={replicas}")
        self.replicas[namespace] = replicas

    def box_pods(self, namespace: str) -> list[dict[str, Any]]:
        self.looked.append(namespace)
        return self.pods.get(namespace, [])

    def events(self, namespace: str) -> list[dict[str, Any]]:
        return []

    def warn_box(self, namespace: str, reason: str, message: str) -> None:
        pass

    def _call(self, method: str, path: str, body: Any = None, timeout: float = 20) -> dict:
        if path.startswith("/api/v1/nodes"):
            return {"items": []}
        if path.startswith("/apis/apps/v1/"):
            return {"spec": {"replicas": 1}, "status": {"readyReplicas": 1}}
        return {}


class FakeRestartCore:
    def __init__(self, machine_id: str):
        self.actions = [
            {
                "action_id": A1,
                "kind": "restart",
                "step": None,
                "target": {"machine_id": machine_id},
                "requested_at": "2026-10-29T15:59:00Z",
                "expires_at": "2099-01-01T00:00:00Z",
            }
        ]
        self.steps: list[tuple[str, str]] = []

    def open_actions(self) -> list[dict[str, Any]]:
        return self.actions

    def step(self, action_id: str, step: str, state: str) -> None:
        self.steps.append((step, state))
        self.actions[0]["step"] = step


class FakeRestartKube:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    def box_pod(self, namespace: str) -> dict[str, Any] | None:
        return None

    def delete_box_pod(self, namespace: str, uid: str | None = None) -> None:
        self.deleted.append(namespace)


def _running(machine_id: str) -> dict[str, Any]:
    return {"machine_id": machine_id, "desired_state": "running", "revision": 3}


def _workers(tmp_path: Path, env: dict[str, str], boxes: dict[str, str], **kw: Any) -> Workers:
    core = kw.pop("core", FakeCore([_running(m) for m in boxes]))
    return Workers(
        core,
        kw.pop("kube", FakeKube()),
        _box_map(tmp_path, boxes),
        env,
        restart_core=kw.pop("restart_core", FakeRestartCore(M1)),
        restart_kube=kw.pop("restart_kube", FakeRestartKube()),
    )


# ── The mounts and settings ──────────────────────────────────────────────────


def test_the_core_url_is_https_with_no_credentials() -> None:
    assert check_core_url(URL) == URL
    assert check_core_url("https://10.0.1.10") == "https://10.0.1.10"
    for bad in (
        "http://core.example.invalid",
        "http://127.0.0.1:8510",  # the Mac's tunnel is not for the cluster
        f"https://user:{TOKEN}@core.example.invalid",
        f"https://{TOKEN}@core.example.invalid",
        f"https://core.example.invalid/?token={TOKEN}",
        f"https://core.example.invalid/#{TOKEN}",
        "https://core.example.invalid:notaport",
        "https://",
    ):
        with pytest.raises(WorkersConfigError) as refused:
            check_core_url(bad)
        assert TOKEN not in str(refused.value)


def test_the_core_token_is_read_again_on_every_call(tmp_path: Path) -> None:
    token_file = _write(tmp_path / "token", "first-token\n")
    made: list[tuple[str, str]] = []

    class Api:
        def __init__(self, url: str, token: str):
            made.append((url, token))

        def machines(self) -> list[dict[str, Any]]:
            return []

    core = FreshCore(URL, token_file, Api)
    core.machines()
    _write(token_file, "renewed-token")
    core.machines()
    assert made == [(URL, "first-token"), (URL, "renewed-token")]
    _write(token_file, "")
    with pytest.raises(ValueError):
        core.machines()


def test_both_kube_clients_read_the_rotating_token_on_every_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_file = _write(tmp_path / "token", "sa-one")
    sent: list[str | None] = []

    def fake_open(req, ctx=None, timeout=20):  # type: ignore[no-untyped-def]
        sent.append(req.get_header("Authorization"))
        return io.BytesIO(b'{"items": []}')

    class Opener:
        def open(self, req, timeout=20):  # type: ignore[no-untyped-def]
            return fake_open(req)

    monkeypatch.setattr(box_scaler, "_open", fake_open)
    monkeypatch.setattr(restart_actions, "build_opener", lambda *handlers: Opener())
    monkeypatch.setattr(box_scaler.ssl, "create_default_context", lambda cafile=None: None)
    ca = str(tmp_path / "ca.crt")
    scaler_kube = InClusterKubeApi("https://10.100.0.1:443", token_file, ca)
    restart_kube = InClusterRestartKubeApi("https://10.100.0.1:443", token_file, ca)
    scaler_kube.box_pods(NS1)
    restart_kube.box_pod(NS1)
    _write(token_file, "sa-two")
    scaler_kube.box_pods(NS1)
    restart_kube.box_pod(NS1)
    assert sent == ["Bearer sa-one", "Bearer sa-one", "Bearer sa-two", "Bearer sa-two"]


def test_the_in_cluster_address() -> None:
    assert in_cluster_server({"KUBERNETES_SERVICE_HOST": "10.100.0.1"}) == "https://10.100.0.1:443"
    assert (
        in_cluster_server({"KUBERNETES_SERVICE_HOST": "fd00::1", "KUBERNETES_SERVICE_PORT": "6443"})
        == "https://[fd00::1]:6443"
    )
    with pytest.raises(WorkersConfigError):
        in_cluster_server({})


def test_the_interval_and_the_switches() -> None:
    assert interval_from_env({}) == 10.0
    assert interval_from_env({"SWITCH_HOSTED_WORKERS_INTERVAL_SECONDS": "30"}) == 30.0
    for bad in ("0", "1", "301", "soon"):
        with pytest.raises(WorkersConfigError):
            interval_from_env({"SWITCH_HOSTED_WORKERS_INTERVAL_SECONDS": bad})
    assert switches_from_env({}) == dict.fromkeys(
        ("scaler", "evictions", "cluster_report", "restart"), False
    )
    assert switches_from_env(ALL_ON) == dict.fromkeys(
        ("scaler", "evictions", "cluster_report", "restart"), True
    )
    for bad in ("on", "true", "2"):
        with pytest.raises(WorkersConfigError):
            switches_from_env({"SWITCH_HOSTED_WORKERS_RESTART": bad})


def test_the_core_ca_setting(tmp_path: Path) -> None:
    """Unset, Core keeps the default store. Set, it must name a readable CA file, and nothing
    process-wide is changed. `test_workers_core_ca.py` proves the trust itself
    against real TLS servers."""
    assert core_tls_context({}) is None
    with pytest.raises(WorkersConfigError, match="is not a file"):
        core_tls_context({"SWITCH_HOSTED_WORKERS_CORE_CA": str(tmp_path / "missing.crt")})
    junk = _write(tmp_path / "junk.crt", "not a certificate")
    with pytest.raises(WorkersConfigError, match="could not be read as a CA"):
        core_tls_context({"SWITCH_HOSTED_WORKERS_CORE_CA": str(junk)})


def test_the_box_map_folder_is_read_each_round_and_a_bad_one_keeps_the_last(
    tmp_path: Path,
) -> None:
    core = FakeCore([_running(M1), _running(M2)])
    workers = _workers(tmp_path, ALL_ON, {M1: NS1}, core=core)
    restart = workers.restart
    assert workers.run_round()["box_map"] == "ok"
    assert workers.boxes == {M1: NS1}
    _box_map(tmp_path, {M1: NS1, M2: NS2})
    workers.run_round()
    assert workers.boxes == {M1: NS1, M2: NS2}
    assert restart is not None and dict(restart.boxes) == {M1: NS1, M2: NS2}  # the same map
    (tmp_path / "box-map" / "..2026_10_29_16_00_00.000000001" / M2).chmod(0o444)  # world-readable
    assert workers.run_round()["box_map"] == "failed"
    assert workers.boxes == {M1: NS1, M2: NS2}
    assert [m for m, _ in core.observed][-2:] == [M1, M2]


# ── The switches ─────────────────────────────────────────────────────────────


def test_all_off_does_nothing(tmp_path: Path) -> None:
    kube = FakeKube()
    restart_kube = FakeRestartKube()
    workers = _workers(tmp_path, {}, {M1: NS1}, kube=kube, restart_kube=restart_kube)
    assert workers.run_round() == {
        "box_map": "ok",
        "scaler": "off",
        "evictions": "off",
        "box_facts": "off",
        "cluster_report": "off",
        "restart": "off",
    }
    assert kube.looked == [] and restart_kube.deleted == []


def test_the_scaler_alone_sends_no_extra_fields(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    workers = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    assert workers.run_round()["scaler"] == "ok"
    assert core.observed == [(M1, {"state": "running"})]  # an older Core refuses unknown fields
    assert kube.looked == []


def test_evictions_alone_look_at_every_box_without_the_scaler(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    env = {"SWITCH_HOSTED_WORKERS_EVICTIONS": "1"}
    workers = _workers(tmp_path, env, {M1: NS1, M2: NS2}, core=core, kube=kube)
    outcome = workers.run_round()
    assert outcome["scaler"] == "off" and outcome["evictions"] == "ok"
    assert kube.looked == [NS1, NS2]
    assert core.observed == []


def test_all_on(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    kube.pods[NS1] = [_pod("u1", restarts=2)]
    restart_core, restart_kube = FakeRestartCore(M1), FakeRestartKube()
    env = {
        **ALL_ON,
        "SWITCH_SCALER_REPORT_EVICTIONS": "1",
        "SWITCH_SCALER_REPORT_BOX_FACTS": "1",
    }
    workers = _workers(
        tmp_path,
        env,
        {M1: NS1},
        core=core,
        kube=kube,
        restart_core=restart_core,
        restart_kube=restart_kube,
    )
    assert set(workers.run_round().values()) == {"ok"}
    kube.pods[NS1] = [_pod("u1", restarts=5)]
    workers.run_round()
    assert core.observed[-1] == (
        M1,
        {"state": "running", "evictions": 0, "restarts": 3, "node": "ip-10-0-1-7"},
    )
    assert len(core.reports) == 1  # at most every 30 s
    assert {s["name"] for s in core.reports[0]["services"]} >= {"squid", "hosted-controller"}
    assert restart_kube.deleted == [NS1]  # once, from the box map
    assert restart_core.steps[:2] == [("claimed", "running"), ("pod_deleted", "running")]


def test_box_facts_need_the_eviction_watch(tmp_path: Path) -> None:
    env = {**SCALER, "SWITCH_SCALER_REPORT_BOX_FACTS": "1"}
    workers = _workers(tmp_path, env, {M1: NS1})
    assert workers.box_facts is None
    assert workers.run_round()["box_facts"] == "off"


def test_bad_settings_refuse_to_start(tmp_path: Path) -> None:
    with pytest.raises(ValueError):  # no namespaces for the cluster report
        _workers(tmp_path / "a", {"SWITCH_HOSTED_WORKERS_CLUSTER_REPORT": "1"}, {M1: NS1})
    with pytest.raises(WorkersConfigError):
        Workers(FakeCore(), FakeKube(), tmp_path, {"SWITCH_HOSTED_WORKERS_RESTART": "1"})


# ── One worker failing ───────────────────────────────────────────────────────


def test_core_down_for_the_scaler_leaves_the_others(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    core.fail_machines = RuntimeError(f"Core call failed: {URL} {TOKEN}")
    kube.pods[NS1] = [_pod("u1", restarts=1)]
    restart_kube = FakeRestartKube()
    env = {**ALL_ON, "SWITCH_SCALER_REPORT_BOX_FACTS": "1"}
    workers = _workers(
        tmp_path, env, {M1: NS1, M2: NS2}, core=core, kube=kube, restart_kube=restart_kube
    )
    with caplog.at_level(logging.INFO):
        outcome = workers.run_round()
        kube.pods[NS1] = [_pod("u1", restarts=4)]
        workers.run_round()
    assert outcome["scaler"] == "failed"
    assert {outcome[k] for k in ("evictions", "box_facts", "cluster_report", "restart")} == {"ok"}
    assert kube.looked == [NS1, NS2, NS1, NS2]  # every box, every round, without Core's list
    assert workers.box_facts is not None and workers.box_facts.unreported(M1) == 3
    assert len(core.reports) == 1
    assert restart_kube.deleted == [NS1]
    assert "RuntimeError" in caplog.text
    assert TOKEN not in caplog.text and URL not in caplog.text


@pytest.mark.parametrize("broken", ["cluster", "restart"])
def test_a_failing_worker_leaves_the_scaler(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, broken: str
) -> None:
    core = FakeCore([_running(M1)])
    workers = _workers(tmp_path, ALL_ON, {M1: NS1}, core=core)

    class Broken:
        def tick(self) -> None:
            raise OSError(f"bad {TOKEN}")

    setattr(workers, broken, Broken())
    with caplog.at_level(logging.INFO):
        outcome = workers.run_round()
    assert outcome["cluster_report" if broken == "cluster" else "restart"] == "failed"
    assert outcome["scaler"] == outcome["evictions"] == "ok"
    assert core.observed == [(M1, {"state": "running"})]
    assert TOKEN not in caplog.text


def test_a_failing_scaler_leaves_the_restart_worker(tmp_path: Path) -> None:
    kube, restart_kube = FakeKube(), FakeRestartKube()

    def broken(namespace: str) -> tuple[int, int]:
        raise ConnectionError("down")

    kube.scale = broken  # type: ignore[method-assign]
    workers = _workers(tmp_path, ALL_ON, {M1: NS1}, kube=kube, restart_kube=restart_kube)
    outcome = workers.run_round()
    assert outcome["scaler"] == "failed" and outcome["restart"] == "ok"
    assert restart_kube.deleted == [NS1]


def test_odd_pod_data_skips_the_restart_count_not_the_scaler(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1), _running(M2)]), FakeKube()
    bad = _pod("u1")
    bad["status"]["containerStatuses"] = [{"restartCount": "lots"}]
    kube.pods = {NS1: [bad], NS2: [_pod("u2")]}
    env = {**SCALER_AND_EVICTIONS, "SWITCH_SCALER_REPORT_BOX_FACTS": "1"}
    workers = _workers(tmp_path, env, {M1: NS1, M2: NS2}, core=core, kube=kube)
    assert workers.run_round()["scaler"] == "ok"
    assert [m for m, _ in core.observed] == [M1, M2]


def test_the_eviction_watch_failing_leaves_the_scaler(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()

    def broken(namespace: str) -> list[dict[str, Any]]:
        raise ConnectionError("down")

    kube.box_pods = broken  # type: ignore[method-assign]
    workers = _workers(tmp_path, SCALER_AND_EVICTIONS, {M1: NS1}, core=core, kube=kube)
    assert workers.run_round()["scaler"] == "ok"
    assert core.observed == [(M1, {"state": "running"})]


# ── Starting up ──────────────────────────────────────────────────────────────


def _mounts(tmp_path: Path) -> tuple[dict[str, str], Path]:
    sa = tmp_path / "sa"
    sa.mkdir(parents=True)
    _write(sa / "token", "sa-token")
    _write(sa / "ca.crt", "not read in this test")
    env = {
        **ALL_ON,
        "KUBERNETES_SERVICE_HOST": "10.100.0.1",
        "SWITCH_HOSTED_WORKERS_CORE_URL": URL,
        "SWITCH_HOSTED_WORKERS_CORE_TOKEN_FILE": str(_write(tmp_path / "core-token", TOKEN)),
        "SWITCH_HOSTED_WORKERS_BOX_MAP": str(_box_map(tmp_path, {M1: NS1})),
    }
    return env, sa


def test_it_starts_and_stops_on_the_in_cluster_account(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(box_scaler.ssl, "create_default_context", lambda cafile=None: None)
    monkeypatch.setattr(restart_actions.ssl, "create_default_context", lambda cafile=None: None)
    env, sa = _mounts(tmp_path)
    workers, interval = build(env, sa)
    assert interval == 10.0 and isinstance(workers.kube, InClusterKubeApi)
    assert workers.restart is not None and workers.cluster is not None
    assert "kubeconfig" not in Path(workers_main.__file__).read_text().lower()
    stop = threading.Event()
    stop.set()
    assert main(env, sa, stop) == 0


def test_a_bad_mount_refuses_to_start_without_logging_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(box_scaler.ssl, "create_default_context", lambda cafile=None: None)
    monkeypatch.setattr(restart_actions.ssl, "create_default_context", lambda cafile=None: None)
    stop = threading.Event()
    stop.set()
    changes = (
        lambda env, sa: env.pop("SWITCH_HOSTED_WORKERS_BOX_MAP"),
        lambda env, sa: env.pop("KUBERNETES_SERVICE_HOST"),
        lambda env, sa: (sa / "token").unlink(),
        lambda env, sa: (sa / "ca.crt").unlink(),
        lambda env, sa: _write(Path(env["SWITCH_HOSTED_WORKERS_CORE_TOKEN_FILE"]), ""),
        lambda env, sa: env.update(
            SWITCH_HOSTED_WORKERS_CORE_URL=f"https://a:{TOKEN}@core.example.invalid"
        ),
        lambda env, sa: env.update(SWITCH_HOSTED_WORKERS_CORE_CA=str(sa / "missing.crt")),
        lambda env, sa: env.update(SWITCH_HOSTED_WORKERS_SCALER="yes"),
        lambda env, sa: env.pop("SWITCH_CLUSTER_PROXY_NAMESPACE"),
    )
    for i, change in enumerate(changes):
        env, sa = _mounts(tmp_path / str(i))
        change(env, sa)
        with caplog.at_level(logging.INFO):
            assert main(env, sa, stop) == 2, i
    assert TOKEN not in caplog.text and "core.example.invalid" not in caplog.text
    assert json.dumps(caplog.messages).count("Not starting") == len(changes)


def test_one_info_line_a_round_with_counts_only(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    kube = FakeKube()
    kube.replicas[NS1] = 0  # Core wants it running: one scale-up
    workers = _workers(tmp_path, SCALER_AND_EVICTIONS, {M1: NS1, M2: NS2}, kube=kube)
    with caplog.at_level(logging.INFO, logger="switch_hosted_controller.workers_main"):
        workers.run_round()
    rounds = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Round:")]
    assert rounds == [
        "Round: boxes=2 scaled=1 evicted=0 box_map=ok scaler=ok evictions=ok"
        " box_facts=off cluster_report=off restart=off"
    ]
    assert NS1 not in rounds[0] and M1 not in rounds[0]


# ── Registration codes, with the scaler ──────────────────────────────────────

CODE = "CODE-CANARY-9d1e-never-logged"


def test_a_new_box_gets_its_code_just_before_its_first_start(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    core.codes[M1] = CODE
    kube.replicas[NS1] = 0  # made by the provisioner, never started
    workers = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    with caplog.at_level(logging.INFO):
        workers.run_round()
    assert kube.order == ["code", "replicas=1"]
    assert kube.secret[NS1] == CODE
    assert CODE not in caplog.text


def test_a_registered_box_has_its_code_cleared(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    kube.secret[NS1] = CODE  # spent: Core holds no code once the box registered
    workers = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    workers.run_round()
    assert core.prepared == [M1]
    assert kube.secret[NS1] is None


def test_core_failing_prepare_never_stops_a_start(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    kube.replicas[NS1] = 0

    def broken(machine_id: str) -> dict[str, Any]:
        raise RuntimeError(f"down {CODE}")

    core.prepare = broken  # type: ignore[method-assign]
    workers = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    assert workers.run_round()["scaler"] == "ok"
    assert kube.order == ["replicas=1"]


def test_no_codes_without_the_scaler(tmp_path: Path) -> None:
    core, kube = FakeCore([_running(M1)]), FakeKube()
    core.codes[M1] = CODE
    env = {"SWITCH_HOSTED_WORKERS_EVICTIONS": "1"}
    workers = _workers(tmp_path, env, {M1: NS1}, core=core, kube=kube)
    workers.run_round()
    assert workers.codes is None and core.prepared == [] and kube.secret == {}


def test_the_core_client_passes_prepare_through(tmp_path: Path) -> None:
    token_file = _write(tmp_path / "token", "t")

    class Api:
        def __init__(self, url: str, token: str):
            pass

        def prepare(self, machine_id: str) -> dict[str, Any]:
            return {"controllers": [{"enrollment_code": CODE}], "machine": machine_id}

    assert FreshCore(URL, token_file, Api).prepare(M1)["machine"] == M1


# ── No redirects, on every client workers uses ───────────────────────────────


def test_no_client_follows_a_redirect(tmp_path: Path) -> None:
    """A real local server answers 302 to another path. Every client must stop
    there: the bearer is never carried to the redirect's target."""
    import threading as _threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from switch_hosted_controller.box_scaler import CoreApi
    from switch_hosted_controller.restart_actions import RestartCoreApi

    landed: list[str | None] = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self) -> None:
            if self.path.startswith("/landed"):
                landed.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")
                return
            self.send_response(302)
            self.send_header("Location", "/landed")
            self.end_headers()

        do_GET = do_POST = do_DELETE = do_PATCH = _answer  # noqa: N815

        def log_message(self, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    _threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    token_file = _write(tmp_path / "token", TOKEN)
    try:
        calls = [
            lambda: InClusterKubeApi(origin, token_file, None).box_pods(NS1),  # type: ignore[arg-type]
            lambda: InClusterRestartKubeApi(origin, token_file, None).box_pod(NS1),  # type: ignore[arg-type]
            lambda: CoreApi(origin, TOKEN).machines(),
            lambda: RestartCoreApi(origin, TOKEN).open_actions(),
        ]
        for call in calls:
            with pytest.raises(Exception):  # noqa: B017 - each client's own error type
                call()
    finally:
        server.shutdown()
    assert landed == []
