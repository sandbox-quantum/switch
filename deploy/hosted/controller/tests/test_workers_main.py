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


def _pod(uid: str, restarts: int = 0, node: str = "ip-10-0-0-11") -> dict[str, Any]:
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
        self.pool_boxes: list[dict[str, Any]] = []

    def prepare(self, machine_id: str) -> dict[str, Any]:
        self.prepared.append(machine_id)
        code = self.codes.get(machine_id)
        return {"controllers": [{"enrollment_code": code} if code else {}]}

    def machines(self) -> list[dict[str, Any]]:
        if self.fail_machines is not None:
            raise self.fail_machines
        return self.listed

    def pool(self) -> list[dict[str, Any]]:
        return self.pool_boxes

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
        {"state": "running", "evictions": 0, "restarts": 3, "node": "ip-10-0-0-11"},
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
        "Round: boxes=2 legacy_names=0 scaled=1 evicted=0 box_map=ok scaler=ok evictions=ok"
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


# ── The box map through the API ─────────────────────────────────────────

import base64  # noqa: E402
import time  # noqa: E402

from switch_hosted_controller.box_scaler import (  # noqa: E402
    START_LIMIT_S,
    ScalerConfigError,
    boxes_from_secret,
)
from switch_hosted_controller.workers_main import CHECK_S, FAST_S  # noqa: E402


def _secret(boxes: dict[str, str]) -> dict[str, Any]:
    return {
        "metadata": {"name": "box-map", "resourceVersion": "7"},
        "data": {k: base64.b64encode(v.encode()).decode() for k, v in boxes.items()},
    }


def test_the_box_map_secret_is_read_whole_or_refused_whole() -> None:
    assert boxes_from_secret(_secret({M1: NS1, M2: NS2})) == {M1: NS1, M2: NS2}
    assert boxes_from_secret({"metadata": {}}) == {}  # a new cluster: no boxes yet
    assert boxes_from_secret({"data": None}) == {}
    bad = (
        {"data": {M1: "not base64!"}},
        {"data": {M1: base64.b64encode(b"kube-system").decode()}},
        {"data": {"not-a-uuid": base64.b64encode(NS1.encode()).decode()}},
        _secret({M1: NS1, M2: NS1}),
        {"data": ["a list"]},
    )
    for secret in bad:
        with pytest.raises(ScalerConfigError) as refused:
            boxes_from_secret(secret)
        assert NS1 not in str(refused.value) and "kube-system" not in str(refused.value)


def test_the_box_map_is_read_by_name_only(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(box_scaler.ssl, "create_default_context", lambda cafile=None: None)
    api = InClusterKubeApi("https://10.100.0.1:443", _write(tmp_path / "t", "sa-token"), "ca")
    calls: list[tuple[str, str]] = []

    def call(method: str, path: str, body: Any = None, timeout: float = 20) -> dict:
        calls.append((method, path))
        return _secret({M1: NS1})

    monkeypatch.setattr(api, "_call", call)
    assert api.box_map() == {M1: NS1}
    assert calls == [("GET", "/api/v1/namespaces/switch-hosted/secrets/box-map")]


def test_an_api_error_keeps_the_last_good_box_map(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    answers: list[Any] = [
        {M1: NS1},
        RuntimeError("API down"),
        ScalerConfigError(NS2),
        {M1: NS1, M2: NS2},
    ]

    def read() -> dict[str, str]:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    workers = Workers(FakeCore([_running(M1), _running(M2)]), FakeKube(), read, SCALER)
    held = workers.boxes
    assert workers.run_round()["box_map"] == "ok" and workers.boxes == {M1: NS1}
    with caplog.at_level(logging.WARNING):
        assert workers.run_round()["box_map"] == "failed"
        assert workers.run_round()["box_map"] == "failed"
    assert workers.boxes == {M1: NS1}  # the last good map, still in use
    assert "keeping the last good one" in caplog.text and NS2 not in caplog.text
    workers.run_round()
    assert workers.boxes == {M1: NS1, M2: NS2} and workers.boxes is held  # updated in place


def test_a_first_read_that_fails_touches_no_box(tmp_path: Path) -> None:
    def read() -> dict[str, str]:
        raise RuntimeError("API down")

    kube = FakeKube()
    kube.replicas[NS1] = 0
    workers = Workers(FakeCore([_running(M1)]), kube, read, SCALER)
    workers.run_round()
    assert workers.boxes == {} and kube.order == []


def test_the_mount_setting_is_no_longer_needed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(box_scaler.ssl, "create_default_context", lambda cafile=None: None)
    monkeypatch.setattr(restart_actions.ssl, "create_default_context", lambda cafile=None: None)
    env, sa = _mounts(tmp_path)
    with caplog.at_level(logging.WARNING):
        workers, _ = build(env, sa)
    assert callable(workers._box_map) and "no longer read" in caplog.text
    env.pop("SWITCH_HOSTED_WORKERS_BOX_MAP")
    workers, _ = build(env, sa)
    assert workers._box_map == workers.kube.box_map


# ── The fast passes between full rounds ─────────────────────────────────


class SlowKube(FakeKube):
    """A box that becomes ready only when told: scale reads are counted per namespace."""

    def __init__(self) -> None:
        super().__init__()
        self.ready: dict[str, int] = {}
        self.reads: list[str] = []

    def scale(self, namespace: str) -> tuple[int, int]:
        self.reads.append(namespace)
        return self.replicas.get(namespace, 0), self.ready.get(namespace, 0)


def time_now() -> float:
    return time.monotonic()


def _stopped(machine_id: str, revision: int = 3) -> dict[str, Any]:
    return {"machine_id": machine_id, "desired_state": "stopped", "revision": revision}


def _fast(
    boxes: dict[str, str],
    listed: list[dict[str, Any]],
    kube: FakeKube | None = None,
    read: Any = None,
) -> tuple[Workers, FakeCore, Any]:
    core = FakeCore(listed)
    kube = kube or SlowKube()
    workers = Workers(core, kube, read or (lambda: dict(boxes)), SCALER)
    workers._interval = 30.0
    workers.run_round()
    return workers, core, kube


def test_a_wake_is_acted_on_at_the_next_check_not_the_next_round() -> None:
    kube = SlowKube()
    kube.replicas[NS1] = kube.replicas[NS2] = 0
    workers, core, kube = _fast({M1: NS1, M2: NS2}, [_stopped(M1), _stopped(M2)], kube)
    assert workers.fast_tick(100.0) == CHECK_S  # the first look only remembers
    kube.reads.clear()
    core.listed = [_running(M1), _stopped(M2)]  # Core wants M1 awake (revision 3, desired changed)
    assert workers.fast_tick(105.0) == FAST_S  # it is starting now: 2 s passes
    assert kube.replicas[NS1] == 1 and kube.order[-1] == "replicas=1"
    assert kube.reads == [NS1]  # only the box that changed was read
    assert core.observed[-1] == (M1, {"state": "provisioning"})


def test_a_starting_box_gets_2s_passes_for_itself_only_and_is_reported_on_change() -> None:
    kube = SlowKube()
    kube.replicas[NS1], kube.replicas[NS2] = 0, 1
    kube.ready[NS2] = 1
    workers, core, kube = _fast({M1: NS1, M2: NS2}, [_running(M1), _running(M2)], kube)
    # The full round started M1; it is waiting to be ready.
    assert workers.starting(time_now()) == {M1}
    reported = len(core.observed)
    kube.reads.clear()
    for tick in range(3):
        assert workers.fast_tick(time_now()) == FAST_S
    assert kube.reads == [NS1, NS1, NS1]  # never M2, whose box is running
    assert len(core.observed) == reported  # still provisioning: nothing new to say
    kube.ready[NS1] = 1
    assert workers.fast_tick(time_now()) == CHECK_S
    assert core.observed[-1] == (M1, {"state": "running"})
    assert workers.starting(time_now()) == set()


def test_the_fast_passes_end_at_the_start_limit() -> None:
    kube = SlowKube()
    kube.replicas[NS1] = 0
    workers, core, kube = _fast({M1: NS1}, [_running(M1)], kube)
    later = time_now() + START_LIMIT_S + 1
    assert workers.starting(later) == set()
    kube.reads.clear()
    workers._next_check = later + 1  # no check due yet
    assert workers.fast_tick(later) == pytest.approx(1.0)
    assert (
        kube.reads == []
    )  # a box past the limit waits for the full round (which reports the error)


def test_a_stop_is_acted_on_as_fast_as_a_wake() -> None:
    kube = SlowKube()
    kube.replicas[NS1] = kube.ready[NS1] = 1
    workers, core, kube = _fast({M1: NS1}, [_running(M1)], kube)
    workers.fast_tick(time_now())
    core.listed = [_stopped(M1, revision=4)]
    workers.fast_tick(time_now() + CHECK_S)
    assert kube.replicas[NS1] == 0 and core.observed[-1] == (M1, {"state": "stopping"})


def test_a_new_box_in_the_map_is_started_at_the_next_check() -> None:
    boxes = {M1: NS1}
    reads = {"n": 0}

    def read() -> dict[str, str]:
        reads["n"] += 1
        return dict(boxes)

    kube = SlowKube()
    kube.replicas[NS1] = kube.ready[NS1] = 1
    workers, core, kube = _fast({}, [_running(M1)], kube, read=read)
    workers.fast_tick(time_now())
    workers.fast_tick(time_now() + CHECK_S)
    assert reads["n"] == 1  # nothing unknown changed: the map isn't read again
    # The provisioner made M2's box (at 0) and Core now lists it, wanted running.
    boxes[M2] = NS2
    kube.replicas[NS2] = 0
    core.listed = [_running(M1), _running(M2)]
    assert workers.fast_tick(time_now() + 2 * CHECK_S) == FAST_S
    assert reads["n"] == 2 and kube.replicas[NS2] == 1


def test_an_existing_box_re_used_starts_at_the_next_check_without_reading_the_map() -> None:
    """A re-used box (a retry or re-claim: the provisioner kept the box and its map entry) is already
    in the map. Core wanting it running is a change to a box we know, so it starts at the next check,
    and the box map isn't read again for it."""
    reads = {"n": 0}

    def read() -> dict[str, str]:
        reads["n"] += 1
        return {M1: NS1}

    kube = SlowKube()
    kube.replicas[NS1] = 0
    workers, core, kube = _fast({}, [_stopped(M1, revision=1)], kube, read=read)
    workers.fast_tick(time_now())
    core.listed = [_running(M1) | {"revision": 2}]
    assert workers.fast_tick(time_now() + CHECK_S) == FAST_S
    assert kube.replicas[NS1] == 1 and reads["n"] == 1


def test_a_failed_check_backs_off_to_the_round_interval_then_recovers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    workers, core, kube = _fast({M1: NS1}, [_running(M1)])
    workers._waiting.clear()
    core.fail_machines = RuntimeError(TOKEN)
    with caplog.at_level(logging.WARNING):
        waits = [workers.fast_tick(t) for t in (0.0, 10.0, 30.0, 60.0, 90.0)]
    assert waits == [10.0, 20.0, 30.0, 30.0, 30.0]
    assert TOKEN not in caplog.text
    core.fail_machines = None
    assert workers.fast_tick(120.0) == CHECK_S


def test_with_the_scaler_off_there_are_no_fast_checks() -> None:
    core = FakeCore([_running(M1)])
    workers = Workers(
        core,
        FakeKube(),
        lambda: {M1: NS1},
        SCALER_AND_EVICTIONS | {"SWITCH_HOSTED_WORKERS_SCALER": "0"},
    )
    workers._interval = 30.0
    core.fail_machines = AssertionError("not called")
    assert workers.fast_tick(0.0) == 30.0


class FakeClockStop(threading.Event):
    """`stop.wait` moves a fake clock on instead of sleeping, and stops after `until`."""

    def __init__(self, until: float) -> None:
        super().__init__()
        self.now = 0.0
        self.until = until
        self.waits: list[float] = []

    def clock(self) -> float:
        return self.now

    def wait(self, timeout: float | None = None) -> bool:
        self.waits.append(timeout or 0.0)
        self.now += timeout or 0.0
        if self.now >= self.until:
            self.set()
        return self.is_set()


def test_the_loop_runs_full_rounds_on_the_interval_and_checks_between() -> None:
    core = FakeCore([_stopped(M1)])
    workers = Workers(core, SlowKube(), lambda: {M1: NS1}, SCALER)
    rounds: list[float] = []
    real = workers.run_round
    stop = FakeClockStop(until=61.0)

    def counted() -> dict[str, str]:
        rounds.append(stop.now)
        return real()

    workers.run_round = counted  # type: ignore[method-assign]
    workers.run(stop, 30.0, clock=stop.clock)
    assert rounds == [0.0, 30.0, 60.0]
    assert max(stop.waits) <= CHECK_S and min(stop.waits) >= 0.0


def test_only_machines_core_lists_now_are_remembered() -> None:
    workers, core, kube = _fast({M1: NS1, M2: NS2}, [_running(M1), _running(M2)])
    workers.fast_tick(time_now())
    assert set(workers._seen) == {M1, M2}
    core.listed = [_running(M1)]
    workers.fast_tick(time_now() + CHECK_S)
    assert set(workers._seen) == {M1}


def test_a_check_reads_core_once_however_many_boxes_are_starting() -> None:
    kube = SlowKube()
    kube.replicas[NS1] = kube.replicas[NS2] = 0
    workers, core, kube = _fast({M1: NS1, M2: NS2}, [_running(M1), _running(M2)], kube)
    reads = {"n": 0}
    real = core.machines

    def counted() -> list[dict[str, Any]]:
        reads["n"] += 1
        return real()

    core.machines = counted  # type: ignore[method-assign]
    assert workers.starting(time_now()) == {M1, M2}
    kube.reads.clear()
    workers.fast_tick(time_now())
    assert reads["n"] == 1 and sorted(kube.reads) == [NS1, NS2]


# ── box_missing: a box Core counts as made, and wants running, that isn't there ──

from urllib.error import HTTPError  # noqa: E402


class MissingKube(SlowKube):
    """`box` StatefulSets that 404 (gone) or fail otherwise, by namespace."""

    def __init__(self) -> None:
        super().__init__()
        self.gone: set[str] = set()
        self.broken: set[str] = set()

    def scale(self, namespace: str) -> tuple[int, int]:
        if namespace in self.gone:
            raise HTTPError("u", 404, "Not Found", None, None)  # type: ignore[arg-type]
        if namespace in self.broken:
            raise HTTPError("u", 503, "Unavailable", None, None)  # type: ignore[arg-type]
        return super().scale(namespace)


def _expected(machine_id: str, desired: str = "running", revision: int = 3) -> dict[str, Any]:
    return {
        "machine_id": machine_id,
        "desired_state": desired,
        "revision": revision,
        "box_expected": True,
    }


def _missing_reports(core: FakeCore) -> list[tuple[str, dict[str, Any]]]:
    return [(m, o) for m, o in core.observed if o.get("error_code") == "box_missing"]


def test_a_box_not_in_the_map_is_reported_missing_once_per_revision(
    caplog: pytest.LogCaptureFixture,
) -> None:
    core = FakeCore([_expected(M1)])
    workers = Workers(core, MissingKube(), lambda: {}, SCALER)
    with caplog.at_level(logging.WARNING):
        workers.run_round()
        workers.run_round()
    assert _missing_reports(core) == [(M1, {"state": "error", "error_code": "box_missing"})]
    core.listed = [_expected(M1, revision=4)]  # Core re-asked: a new revision may be reported again
    workers.run_round()
    assert len(_missing_reports(core)) == 2
    assert "its box is missing (not in the box map)" in caplog.text


def test_a_404_on_the_box_is_missing_and_any_other_error_is_a_failed_step() -> None:
    kube = MissingKube()
    kube.gone.add(NS1)
    kube.broken.add(NS2)
    core = FakeCore([_expected(M1), _expected(M2)])
    workers = Workers(core, kube, lambda: {M1: NS1, M2: NS2}, SCALER)
    outcome = workers.run_round()
    assert _missing_reports(core) == [(M1, {"state": "error", "error_code": "box_missing"})]
    assert outcome["scaler"] == "failed"  # M2's 503 failed its step, and wasn't called missing
    assert workers.starting(time_now()) == set()  # no fast passes for a missing box


def test_no_missing_report_after_a_failed_map_read() -> None:
    answers: list[Any] = [
        {M1: NS1},
        {M1: NS1},
        RuntimeError("API down"),
    ]  # read, re-read, then failing

    def read() -> dict[str, str]:
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    core = FakeCore([_expected(M1), _expected(M2)])
    kube = MissingKube()
    kube.replicas[NS1] = kube.ready[NS1] = 1
    workers = Workers(core, kube, read, SCALER)
    workers.run_round()  # M2 not in a map read fine: missing
    assert [m for m, _ in _missing_reports(core)] == [M2]
    core.listed = [_expected(M1), _expected(M2, revision=4)]
    workers.run_round()  # the read failed: the kept map never counts
    assert [m for m, _ in _missing_reports(core)] == [M2]
    # And a first read that fails, with an empty map, reports nothing.
    core2 = FakeCore([_expected(M1)])
    Workers(
        core2, MissingKube(), lambda: (_ for _ in ()).throw(RuntimeError("x")), SCALER
    ).run_round()
    assert _missing_reports(core2) == []


def test_never_missing_unless_core_expects_the_box_and_wants_it_running() -> None:
    kube = MissingKube()
    kube.gone.add(NS1)
    for listed in (
        [_running(M1)],  # no box_expected: a Core with v2 off, or a box not yet made
        [_expected(M1, desired="stopped")],
        [_expected(M1, desired="retained")],
        [{**_expected(M1), "box_expected": False}],
    ):
        core = FakeCore(listed)
        Workers(core, kube, lambda: {}, SCALER).run_round()
        Workers(core, kube, lambda: {M1: NS1}, SCALER).run_round()
        assert _missing_reports(core) == [], listed
    # Not expected and 404: the step fails as before, without the code.
    core = FakeCore([_running(M1)])
    assert Workers(core, kube, lambda: {M1: NS1}, SCALER).run_round()["scaler"] == "failed"


def test_a_box_that_comes_back_is_reported_anew_if_lost_again() -> None:
    kube = MissingKube()
    kube.gone.add(NS1)
    core = FakeCore([_expected(M1)])
    workers = Workers(core, kube, lambda: {M1: NS1}, SCALER)
    workers.run_round()
    kube.gone.clear()
    kube.replicas[NS1] = kube.ready[NS1] = 1
    workers.run_round()
    kube.gone.add(NS1)
    workers.run_round()
    assert len(_missing_reports(core)) == 2


def test_the_core_client_sends_box_missing_only_as_asked() -> None:
    sent: list[dict[str, Any]] = []
    api = box_scaler.CoreApi("https://core.example.invalid", TOKEN)
    api._call = lambda path, body=None: sent.append(body)  # type: ignore[method-assign,assignment,misc,return-value]
    api.observe(M1, "error", 3, "x", error_code="box_missing")
    api.observe(M1, "error", 3, "x")
    api.observe(M1, "running", 3)
    assert [b["error_code"] for b in sent] == ["box_missing", "machine_needs_attention", None]


def test_a_box_made_between_the_map_read_and_cores_list_is_not_missing() -> None:
    """The race: the operator writes the map entry, then reports done. The round's map read misses M2, Core's
    list (read after) already expects it, and the re-read has it: nothing is reported, and the map is updated."""
    reads: list[dict[str, str]] = [{M1: NS1}, {M1: NS1, M2: NS2}]

    def read() -> dict[str, str]:
        return reads.pop(0) if len(reads) > 1 else reads[0]

    kube = MissingKube()
    kube.replicas[NS1] = kube.ready[NS1] = 1
    core = FakeCore([_expected(M1), _expected(M2)])
    workers = Workers(core, kube, read, SCALER)
    workers.run_round()
    assert _missing_reports(core) == []
    assert workers.boxes == {M1: NS1, M2: NS2}


def test_the_map_is_re_read_once_per_pass_and_a_failed_re_read_reports_nothing() -> None:
    calls = {"n": 0}

    def read() -> dict[str, str]:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("API down")
        return {}

    core = FakeCore([_expected(M1), _expected(M2)])
    workers = Workers(core, MissingKube(), read, SCALER)
    workers.run_round()  # read 1 ok, re-read (2) fails: nothing reported, and only one re-read for both
    assert calls["n"] == 2 and _missing_reports(core) == []
    workers.run_round()  # read 3, re-read 4: both confirmed missing
    assert calls["n"] == 4 and sorted(m for m, _ in _missing_reports(core)) == [M1, M2]
    workers.run_round()  # already reported at this revision: no re-read needed
    assert calls["n"] == 5


def test_missing_reports_are_remembered_only_for_machines_core_lists_now() -> None:
    core = FakeCore([_expected(M1), _expected(M2)])
    workers = Workers(core, MissingKube(), lambda: {}, SCALER)
    workers.run_round()
    assert set(workers._reported_missing) == {M1, M2}
    core.listed = [_expected(M1)]
    workers.run_round()
    assert set(workers._reported_missing) == {M1}


def test_the_round_line_counts_legacy_names_without_naming_them(
    caplog: pytest.LogCaptureFixture,
) -> None:
    legacy = "agents-user-ada"
    workers = Workers(FakeCore([]), FakeKube(), lambda: {M1: NS1, M2: legacy}, SCALER)
    with caplog.at_level(logging.INFO, logger="switch_hosted_controller.workers_main"):
        workers.run_round()
    (line,) = [r.getMessage() for r in caplog.records if r.getMessage().startswith("Round:")]
    assert "legacy_names=1" in line and legacy not in line and NS1 not in line


# ---- warm pool: the scaler starts and stops pool boxes, and does nothing else for them ----

POOL_NS = "agents-box-k1-00000000000000bb"


def test_pool_boxes_are_started_and_stopped_as_core_lists_them_and_never_reported() -> None:
    core, kube = FakeCore([]), SlowKube()
    kube.replicas[POOL_NS] = 0
    core.pool_boxes = [
        {"pool_box_id": "p1", "namespace": POOL_NS, "desired_state": "running"},
        {"pool_box_id": "p2", "namespace": None, "desired_state": "running"},  # not made yet
        {
            "pool_box_id": "p3",
            "namespace": "agents-user-ada",
            "desired_state": "running",
        },  # never a person's box
        {"pool_box_id": "p4", "namespace": "kube-system", "desired_state": "running"},
    ]
    workers = Workers(core, kube, lambda: {}, SCALER)
    workers.run_round()
    assert kube.replicas[POOL_NS] == 1 and kube.order == ["replicas=1"]
    assert core.observed == [] and core.prepared == []  # never reported on, never a code
    core.pool_boxes = [{"pool_box_id": "p1", "namespace": POOL_NS, "desired_state": "stopped"}]
    workers.run_round()
    assert kube.replicas[POOL_NS] == 0


# ── Boxes Core says may not keep their proxy login (`egress-held`) ───────────


class HeldKube(FakeKube):
    def __init__(self) -> None:
        super().__init__()
        self.held_writes: list[set[str]] = []

    def write_egress_held(self, namespaces: set[str]) -> bool:
        self.held_writes.append(set(namespaces))
        return True


def test_the_scaler_writes_the_boxes_core_marks_egress_false(tmp_path: Path) -> None:
    core = FakeCore(
        [
            {**_running(M1), "egress": False},  # given up past its grace: held
            {**_running(M2), "egress": True},
        ]
    )
    kube = HeldKube()
    w = _workers(tmp_path, SCALER, {M1: NS1, M2: NS2}, core=core, kube=kube)
    w.run_round()
    assert kube.held_writes == [{NS1}]
    w.run_round()
    # Offered again every round: the client reads first and writes only if the list differs, so a list emptied or
    # re-made by hand gets its holds back on the next round.
    assert kube.held_writes == [{NS1}, {NS1}]


def test_a_held_list_reset_by_hand_is_written_again_on_the_next_round(tmp_path: Path) -> None:
    class ListKube(FakeKube):
        def __init__(self) -> None:
            super().__init__()
            self.cm: dict[str, Any] = {"metadata": {"resourceVersion": "1"}, "data": {}}
            self.puts = 0

        def _call(self, method: str, path: str, body: Any = None, timeout: float = 20) -> dict:
            if path.endswith("/configmaps/egress-held"):
                if method == "PUT":
                    self.puts += 1
                    self.cm = body
                return self.cm
            return super()._call(method, path, body, timeout)

        write_egress_held = InClusterKubeApi.write_egress_held

    core = FakeCore([{**_running(M1), "egress": False}])
    kube = ListKube()
    w = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    w.run_round()
    assert set(kube.cm["data"]) == {NS1} and kube.puts == 1
    w.run_round()
    assert kube.puts == 1  # unchanged: read, not written
    kube.cm = {"metadata": {"resourceVersion": "7"}, "data": {}}  # emptied or re-made by hand
    w.run_round()
    assert set(kube.cm["data"]) == {NS1} and kube.puts == 2


def test_a_core_without_the_field_holds_nothing_and_a_sleeping_box_is_never_held(
    tmp_path: Path,
) -> None:
    core = FakeCore(
        [{**_running(M1)}, {"machine_id": M2, "desired_state": "stopped", "revision": 3}]
    )
    kube = HeldKube()
    _workers(tmp_path, SCALER, {M1: NS1, M2: NS2}, core=core, kube=kube).run_round()
    assert kube.held_writes == [set()]


def test_the_held_list_is_written_whole_by_name_keeping_its_labels() -> None:
    api = object.__new__(InClusterKubeApi)
    calls: list[tuple[str, str, Any]] = []
    current = {
        "metadata": {"resourceVersion": "9", "labels": {"app.kubernetes.io/part-of": "x"}},
        "data": {NS2: ""},
    }

    def call(method: str, path: str, body: Any = None, timeout: float = 20) -> dict:
        calls.append((method, path, body))
        return current if method == "GET" else {}

    api._call = call  # type: ignore[method-assign]
    assert api.write_egress_held({NS1}) is True
    (get, put) = calls
    assert get[:2] == ("GET", "/api/v1/namespaces/switch-hosted/configmaps/egress-held")
    assert put[0] == "PUT" and put[1] == get[1]
    assert put[2]["data"] == {NS1: ""}  # keys only, empty values; NS2 no longer held
    assert put[2]["metadata"]["labels"] == {"app.kubernetes.io/part-of": "x"}
    assert put[2]["metadata"]["resourceVersion"] == "9"
    calls.clear()
    current["data"] = {NS1: ""}
    assert api.write_egress_held({NS1}) is False and [c[0] for c in calls] == ["GET"]
    with pytest.raises(ValueError):
        api.write_egress_held({"kube-system"})


def test_a_failed_box_map_read_leaves_the_held_list_untouched(tmp_path: Path) -> None:
    """With no good box map this round, the held set can't be trusted (it could come out empty): nothing is written,
    so a held box never gets its login back from a failed read, at start or later."""
    import shutil

    core = FakeCore([{**_running(M1), "egress": False}])
    kube = HeldKube()
    w = _workers(tmp_path, SCALER, {M1: NS1}, core=core, kube=kube)
    w.run_round()
    assert kube.held_writes == [{NS1}]
    shutil.rmtree(tmp_path / "box-map")  # the mounted map unreadable from now on
    assert w.run_round()["box_map"] == "failed"
    assert kube.held_writes == [{NS1}]  # no write this round, empty or otherwise

    fresh = HeldKube()
    w2 = _workers(tmp_path / "second", SCALER, {M1: NS1}, core=core, kube=fresh)
    shutil.rmtree(tmp_path / "second" / "box-map")  # unreadable from the very first round
    w2.run_round()
    assert fresh.held_writes == []


# ── Retired boxes (`box-removals`) are dropped from the box map ──────────────


def test_a_retired_box_is_dropped_from_every_workers_view(tmp_path: Path) -> None:
    class RemovalsKube(HeldKube):
        def __init__(self, removals: Any) -> None:
            super().__init__()
            self.removals = removals

        def box_removals(self) -> dict[str, str]:
            if isinstance(self.removals, Exception):
                raise self.removals
            return self.removals

    w = _workers(tmp_path, SCALER, {M1: NS1, M2: NS2}, kube=RemovalsKube({NS2: M2}))
    w.run_round()
    assert w.boxes == {M1: NS1}  # the scaler, restart worker and eviction watch all hold this map
    w2 = _workers(tmp_path / "b", SCALER, {M1: NS1, M2: NS2}, kube=RemovalsKube(OSError()))
    w2.run_round()
    assert w2.boxes == {M1: NS1, M2: NS2}  # unreadable: the whole map, this round


def test_the_removals_list_is_read_by_name_and_a_missing_one_is_empty() -> None:
    import base64

    api = object.__new__(InClusterKubeApi)
    answers: list[Any] = [
        {"data": {NS1: base64.b64encode(M1.encode()).decode(), "kube-system": "eA=="}}
    ]

    def call(method: str, path: str, body: Any = None, timeout: float = 20) -> dict:
        assert (method, path) == ("GET", "/api/v1/namespaces/switch-hosted/secrets/box-removals")
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    api._call = call  # type: ignore[method-assign]
    assert api.box_removals() == {NS1: M1}  # a non-box key is skipped
    from urllib.error import HTTPError

    answers.append(HTTPError("u", 404, "x", None, None))  # type: ignore[arg-type]
    assert api.box_removals() == {}
