"""The nightly run's arithmetic and report. No requests, no cluster."""

from __future__ import annotations

import json
import signal
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import nightly  # noqa: E402
from nightly import (  # noqa: E402
    Config,
    Night,
    build_of,
    combine,
    compare,
    datadog_series,
    deadline_after,
    history,
    report_text,
    s3_delete,
    s3_get,
    s3_put,
    size_nodegroup,
    verdict,
)
from run import parse_args  # noqa: E402

ENV = {
    "LOADTEST_NAMESPACE": "switch-test",
    "LOADTEST_DEPLOYMENT": "switch-test-switch-core",
    "LOADTEST_API_URL": "http://switch-test-switch-core.switch-test.svc:8000",
    "LOADTEST_CLUSTER": "test-cluster",
    "LOADTEST_CORE_NODEGROUP": "core-",
    "LOADTEST_HARNESS_NODEGROUP": "harness-",
    "AWS_REGION": "us-east-1",
    "LOADTEST_BUCKET": "bucket",
}


def _cfg(**env: str) -> Config:
    return Config.from_env({**ENV, **{f"LOADTEST_{k}": v for k, v in env.items()}})


def _phase(
    name: str, sent: float, p99: float | None, errors=0, missing=0, cpu=40.0
) -> dict:
    return {
        "phase": name,
        "agents_target": 1000,
        "agents_connected_min": 1000,
        "messages_sent_per_s": sent,
        "delivery_ms_p50": 90.0,
        "delivery_ms_p99": p99,
        "errors": errors,
        "deliveries_missing": missing,
        "harness_lag_ms_max": 2.0,
        "pods": {"p1": {"cpu_pct_avg": cpu}, "p2": {"cpu_pct_avg": cpu + 10}},
        "rds": {"cpu_avg": 20.0, "cpu_max": 30.0},
        "db_xact_per_s_avg": 500.0,
    }


def _worker(cfg: Config, broke_at: int | None = None) -> list[dict]:
    """One worker's windows: idle, every rate, stopping after `broke_at`."""
    rates = cfg.worker_rates()
    phases = [_phase("idle@1000", 0.0, None)]
    for k, r in enumerate(rates):
        bad = broke_at is not None and k == broke_at
        phases.append(_phase(f"steady{r:g}@1000", r, 25000.0 if bad else 800.0))
        if bad:
            break
    return phases


def test_the_default_night_is_the_dev_abel_test_after_realistic_steps():
    cfg = _cfg()
    assert (cfg.per_agents, cfg.per_controllers, cfg.per_rooms) == (1000, 50, 500)
    # One message per agent every 30, 10, 5 and 3 minutes, then the ramp.
    assert [round(r, 1) for r in cfg.total_rates()] == [
        5.6, 16.7, 33.3, 55.6, 150, 250, 300, 350, 400, 450, 500,
    ]  # fmt: skip
    assert cfg.worker_rates()[4:] == [15, 25, 30, 35, 40, 45, 50]
    assert cfg.durations() == [600.0] * 4 + [60.0] * 7
    assert (
        cfg.step_labels()[0] == "every 30 min" and cfg.step_labels()[4] == "150 msg/s"
    )


def test_the_harness_takes_the_nightly_rates_and_durations():
    cfg = _cfg()
    a = parse_args(
        [
            "--namespace", "switch-test", "--steps", "1000", "--controllers", "50",
            "--rates", ",".join(f"{r:g}" for r in cfg.worker_rates()),
            "--rate-duration", ",".join(f"{d:g}" for d in cfg.durations()),
        ]
    )  # fmt: skip
    assert a.rate_durations == cfg.durations()


@pytest.mark.parametrize(
    ("env", "why"),
    [
        ({"AGENTS": "10001"}, "split evenly"),
        ({"RAMP": "50,100"}, "less than the first ramp step"),
        ({"DAY_PODS": "13"}, "day sizes"),
        ({"NAMESPACE": "switch"}, "the pilot"),
        ({"API_URL": "http://switch-switch-core.switch.svc:8000"}, "the pilot"),
    ],
)
def test_settings_that_cannot_run_are_refused(env, why):
    with pytest.raises(SystemExit, match=why):
        _cfg(**env)


def test_the_region_comes_from_the_environment_and_is_needed():
    assert _cfg().region == "us-east-1"
    env = {k: v for k, v in ENV.items() if k != "AWS_REGION"}
    assert (
        Config.from_env({**env, "AWS_DEFAULT_REGION": "eu-north-1"}).region
        == "eu-north-1"
    )
    with pytest.raises(SystemExit, match="AWS_REGION is not set"):
        Config.from_env(env)


def test_workers_add_up_by_position_and_the_first_broken_step_is_named():
    cfg = _cfg(WORKERS="2", AGENTS="2000", CONTROLLERS="100")
    # The second worker breaks at the third ramp step (300 msg/s), the first
    # one step later: rows stop where the earliest worker stopped.
    rows = combine(cfg, [_worker(cfg, broke_at=7), _worker(cfg, broke_at=6)])
    assert [r["label"] for r in rows][:2] == ["idle", "every 30 min"]
    assert rows[-1]["label"] == "300 msg/s"
    assert rows[-1]["broken"] == "p99 25.0 s (worker 2)"
    assert rows[1]["sent_per_s"] == pytest.approx(2 * cfg.worker_rates()[0], abs=0.01)
    assert rows[1]["pod_cpu_avg_pct"] == 45.0 and rows[1]["pod_cpu_busiest_pct"] == 50.0
    v = verdict(rows, cfg, [])
    assert v["ok"] and v["held_per_s"] == 250 and v["broke_at_per_s"] == 300


def test_lost_deliveries_at_realistic_load_fail_the_night():
    cfg = _cfg(WORKERS="1", AGENTS="1000", CONTROLLERS="50")
    phases = _worker(cfg)
    phases[2]["deliveries_missing"] = 3
    v = verdict(combine(cfg, [phases]), cfg, [])
    assert not v["ok"] and not v["realistic_ok"]


def test_a_night_that_stopped_early_is_not_complete():
    cfg = _cfg(WORKERS="1", AGENTS="1000", CONTROLLERS="50")
    rows = combine(cfg, [_worker(cfg)[:3]])
    v = verdict(rows, cfg, ["stopped early: deadline"])
    assert not v["ok"] and not v["complete"]
    result = {"build": "b", "pods": 12, "nodes": 4, "rows": rows, "verdict": v}
    result["failures"] = ["stopped early: deadline"]
    assert "staging, 1,000 agents: stopped early: deadline" in report_text(
        result, cfg, []
    )


def test_the_report_fits_discord_and_has_no_em_dash():
    cfg = _cfg(DASHBOARD_URL="https://app.datadoghq.com/dashboard/abc")
    rows = combine(cfg, [_worker(cfg, broke_at=9)] * 10)
    result = {
        "build": "0.31.1-dev.280.gabc1234",
        "pods": 12,
        "nodes": 4,
        "rows": rows,
        "notes": [],
        "restarts": 0,
        "duration_s": 5000,
    }
    result["verdict"] = verdict(rows, cfg, [])
    text = report_text(result, cfg, ["3 earlier night(s) on record"])
    assert text.startswith(
        "✅ Switch nightly load test on staging, 10,000 agents: held 400 msg/s, "
        "broke at 450"
    )
    assert len(text) < 2000 and "—" not in text
    assert "every 3 min" in text and cfg.dashboard_url in text
    assert "were connected" not in text


def test_the_report_says_when_agents_were_not_all_connected():
    cfg = _cfg(WORKERS="2", AGENTS="2000", CONTROLLERS="100")
    short = _worker(cfg)
    short[2] = {**short[2], "agents_connected_min": 940}
    rows = combine(cfg, [_worker(cfg), short])
    result = {"build": "b", "pods": 12, "nodes": 4, "rows": rows}
    result["verdict"] = verdict(rows, cfg, [])
    text = report_text(result, cfg, [])
    assert "⚠️ as few as 1,940 of the 2,000 agents were connected in a step" in text


def test_the_report_goes_to_the_switch_room_as_its_agent(monkeypatch, capsys):
    posts = []

    class Response:
        def raise_for_status(self) -> None:
            pass

    def post(url, json, headers, timeout):
        posts.append((url, json, headers))
        return Response()

    monkeypatch.setattr(nightly.httpx, "post", post)
    nightly.post_switch(_cfg(), "report")
    assert posts == [] and "no Switch room set" in capsys.readouterr().out

    with pytest.raises(ValueError, match="LOADTEST_SWITCH_TOKEN not set"):
        nightly.post_switch(
            _cfg(
                SWITCH_URL="https://switch.example",
                SWITCH_AGENT_ID="a1",
                SWITCH_ROOM_ID="r1",
            ),
            "report",
        )

    cfg = _cfg(
        SWITCH_URL="https://switch.example/",
        SWITCH_AGENT_ID="a1",
        SWITCH_ROOM_ID="r1",
        SWITCH_TOKEN="t1",
    )
    nightly.post_switch(cfg, "report")
    assert posts == [
        (
            "https://switch.example/agents/a1/message",
            {"room_id": "r1", "content": "report"},
            {"Authorization": "Bearer t1"},
        )
    ]
    assert "t1" not in repr(cfg)


def test_comparison_needs_three_nights_and_flags_a_drop():
    def night(held: float, p99: float) -> dict:
        return {
            "verdict": {
                "complete": True,
                "held_per_s": held,
                "realistic_top_p99_ms": p99,
            }
        }

    tonight = night(300, 3000.0)
    assert "comparisons start at 3" in compare(tonight, [night(400, 1000.0)] * 2)[0]
    lines = compare(tonight, [night(400, 1000.0)] * 5)
    assert "⚠️ lower" in lines[0] and "⚠️ slower" in lines[1]
    assert "⚠️" not in "".join(compare(night(400, 1100.0), [night(400, 1000.0)] * 5))


def test_datadog_gets_one_point_per_number_per_night():
    cfg = _cfg()
    rows = combine(cfg, [_worker(cfg, broke_at=9)])
    result = {"build": "b1", "pods": 12, "rows": rows, "restarts": 0, "duration_s": 1}
    result["verdict"] = verdict(rows, cfg, [])
    series = datadog_series(result, cfg, 1_700_000_000.0)
    names = {s["metric"] for s in series}
    assert {"switch.loadtest.ok", "switch.loadtest.held_msgs_per_s"} <= names
    assert all(len(s["points"]) == 1 for s in series)
    p99 = {
        next(t for t in s["tags"] if t.startswith("target:")): s
        for s in series
        if s["metric"] == "switch.loadtest.step.delivery_p99_ms"
    }
    # The idle window has no deliveries, so no p99 point.
    assert "target:idle" not in p99
    assert "env:staging" in p99["target:every_3_min"]["tags"]
    assert "phase:ramp" in p99["target:150_msg/s"]["tags"]


def test_the_deadline_is_tonights_or_three_hours_for_a_run_by_hand():
    night = datetime(2026, 11, 4, 2, 0, tzinfo=UTC)
    assert deadline_after(night, "04:30", timedelta(hours=3)) == night.replace(
        hour=4, minute=30
    )
    day = datetime(2026, 11, 4, 15, 0, tzinfo=UTC)
    assert deadline_after(day, "04:30", timedelta(hours=3)) == day + timedelta(hours=3)


def test_the_build_is_the_chart_version_when_the_release_says_it():
    assert build_of(
        {"helm.sh/chart": "switch-0.31.1-dev.271.g989225d"}, "x@sha256:ab"
    ) == ("0.31.1-dev.271.g989225d")
    assert build_of({}, "ghcr.io/x/switch-core:0.31.1") == "0.31.1"


def test_a_file_bucket_keeps_a_rehearsals_records_in_a_directory(tmp_path):
    cfg = _cfg(BUCKET=f"file://{tmp_path}", PREFIX="rehearsal")
    assert s3_get(cfg, "population.json") is None
    s3_put(cfg, "population.json", {"base": "n1"})
    for night in ("2026-11-01", "2026-11-02", "2026-11-03"):
        s3_put(cfg, f"history/{night}.json", {"night": night})
    assert s3_get(cfg, "population.json") == {"base": "n1"}
    assert (tmp_path / "rehearsal" / "population.json").exists()
    assert [h["night"] for h in history(cfg, before="2026-11-03")] == [
        "2026-11-01",
        "2026-11-02",
    ]
    s3_delete(cfg, "population.json")
    assert s3_get(cfg, "population.json") is None


def test_no_node_group_prefix_sizes_nothing():
    # No AWS call: boto3 is not even installed where the tests run.
    size_nodegroup(_cfg(CORE_NODEGROUP=""), "", 4)


def test_one_worker_over_the_harness_error_limit_breaks_the_step():
    # One worker past run.broken's 20 errors stops stepping; the combined row
    # must say so, or the night reads as unfinished (the review's case).
    cfg = _cfg(WORKERS="2", AGENTS="2000", CONTROLLERS="100")
    a, b = _worker(cfg), _worker(cfg)[:7]
    b[-1]["errors"] = 25
    rows = combine(cfg, [a, b])
    assert (
        rows[-1]["label"] == "250 msg/s"
        and rows[-1]["broken"] == "25 errors (worker 2)"
    )
    v = verdict(rows, cfg, [])
    assert v["complete"] and v["held_per_s"] == 150 and v["broke_at_per_s"] == 250


def test_a_night_that_could_not_read_the_cluster_still_reports(monkeypatch, tmp_path):
    def unreachable(cfg):
        raise RuntimeError("kubectl get deployment: the server is unreachable")

    monkeypatch.setattr(nightly, "core_state", unreachable)
    cfg = _cfg()
    night = Night(cfg, datetime(2026, 11, 4, 2, 0, tzinfo=UTC), "n1", tmp_path)
    night.failures.append("the run failed: RuntimeError: unreachable")
    result = night.result()
    assert result["build"] == "unknown" and result["rows"] == []
    assert not result["verdict"]["ok"]
    assert any("could not read switch-core" in n for n in result["notes"])
    text = report_text(result, cfg, [])
    assert text.startswith("❌") and "no numbers tonight" in text


def test_day_sizes_try_every_step_and_say_which_failed(monkeypatch):
    def unreachable(cfg, replicas):
        raise RuntimeError("the server is unreachable")

    sized = []
    monkeypatch.setattr(nightly, "scale_core", unreachable)
    monkeypatch.setattr(
        nightly, "size_nodegroup", lambda cfg, prefix, n: sized.append((prefix, n))
    )
    left = nightly.day_sizes(_cfg())
    assert sized == [("core-", 1), ("harness-", 0)]
    assert left == ["switch-core: RuntimeError: the server is unreachable"]


def test_down_says_so_when_staging_stays_at_its_night_size(monkeypatch):
    sent = []
    monkeypatch.setattr(nightly, "s3_get", lambda cfg, key: {"night": "2026-11-04"})
    monkeypatch.setattr(nightly, "post_webhook", lambda url, text: sent.append(text))
    monkeypatch.setattr(nightly, "send_datadog", lambda *a: sent.append("datadog"))
    monkeypatch.setattr(nightly, "day_sizes", lambda cfg: [])
    assert nightly.cmd_down(_cfg()) == 0 and sent == []

    monkeypatch.setattr(
        nightly, "day_sizes", lambda cfg: ["switch-core's nodes: AccessDenied"]
    )
    assert nightly.cmd_down(_cfg()) == 1
    # Tonight's numbers are in Datadog already: only the warning goes out.
    assert sent == [
        "⚠️ staging may still be at its night size: putting it back failed for "
        "switch-core's nodes: AccessDenied"
    ]


def _pod(hash_: str, build: str, ready: bool = True, node: str = "n1") -> dict:
    return {
        "metadata": {
            "labels": {"pod-template-hash": hash_, "helm.sh/chart": f"switch-{build}"}
        },
        "spec": {
            "nodeName": node if ready else None,
            "containers": [{"name": "switch-core", "image": f"core:{build}"}],
        },
        "status": {"containerStatuses": [{"ready": True, "restartCount": 0}]}
        if ready
        else {},
    }


def test_the_build_is_what_the_ready_pods_run_not_the_template(monkeypatch):
    # A rollout to b2 that cannot find room for its first pod: the pods still
    # run b1, and the Pending one is no part of what the night measures.
    deployment = {
        "metadata": {"labels": {"helm.sh/chart": "switch-b2"}, "generation": 3},
        "spec": {
            "replicas": 2,
            "selector": {"matchLabels": {"c": "core"}},
            "template": {
                "spec": {"containers": [{"name": "switch-core", "image": "core:b2"}]}
            },
        },
        "status": {"updatedReplicas": 1, "observedGeneration": 3},
    }
    pods = {
        "items": [
            _pod("h1", "b1"),
            _pod("h1", "b1", node="n2"),
            _pod("h2", "b2", ready=False),
        ]
    }

    def kubectl(cfg, *args):
        return json.dumps(deployment if args[1] == "deployment" else pods)

    monkeypatch.setattr(nightly, "kubectl", kubectl)
    s = nightly.core_state(_cfg())
    assert s["build"] == "b1" and s["image"] == "core:b1"
    assert s["ready"] == 2 and s["pod_template_hash"] == ["h1"]
    assert s["updated"] == 1 and s["by_node"] == {"n1": 1, "n2": 1}


class _Proc:
    """A worker process that has exited with `code`, or runs until signalled."""

    def __init__(self, code: int | None = None) -> None:
        self.returncode = code
        self.signals: list[int] = []

    def poll(self) -> int | None:
        return self.returncode

    def wait(self) -> int | None:
        return self.returncode

    def send_signal(self, sig: int) -> None:
        self.signals.append(sig)
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9


def _fake_workers(
    monkeypatch, tmp_path, logs: dict[int, str], codes: dict[int, int | None]
):
    started = []

    def start(cfg, run_id, seed, extra, out):
        log = tmp_path / f"{run_id}.log"
        log.write_text(logs.get(seed, ""))
        w = nightly.Worker(seed, run_id, log, _Proc(codes.get(seed)))
        started.append(w)
        return w

    monkeypatch.setattr(nightly, "start", start)
    monkeypatch.setattr(nightly.time, "sleep", lambda s: None)
    return started


def test_a_worker_that_crashes_after_its_rates_stops_the_night_and_is_named(
    monkeypatch, tmp_path
):
    cfg = _cfg(WORKERS="2", AGENTS="2000", CONTROLLERS="100")
    ready = "step 1: 1000/1000 agents connected\nwaiting for the go\n"
    started = _fake_workers(monkeypatch, tmp_path, {1: ready, 2: ready}, {})

    def sleep(seconds):
        # Worker 2 fails once the rates have started.
        w = started[1] if len(started) > 1 else None
        if w and (tmp_path / "rates.go").exists() and w.proc.returncode is None:
            w.log.write_text(ready + "run failed: RuntimeError: socket gone\n")
            w.proc.returncode = 1

    monkeypatch.setattr(nightly.time, "sleep", sleep)
    workers: list = []
    until = datetime.now(UTC) + timedelta(hours=1)
    stopped, rates_started = nightly.run_workers(
        cfg, {"base": "p"}, "n1", tmp_path, until, workers
    )
    assert rates_started and workers == started and len(workers) == 2
    assert stopped == "worker 2: run failed: RuntimeError: socket gone"
    assert workers[0].proc.signals  # the other one was stopped


def test_a_worker_that_exits_unclean_after_a_break_fails_the_night(
    monkeypatch, tmp_path
):
    cfg = _cfg(WORKERS="2", AGENTS="2000", CONTROLLERS="100")
    ready = "step 1: 1000/1000 agents connected\nwaiting for the go\n"
    _fake_workers(
        monkeypatch,
        tmp_path,
        {
            1: ready + "  steady150 broke (p99 25 s); not stepping higher\n",
            2: ready + "teardown failed\n",
        },
        {1: 0, 2: 1},
    )
    workers: list = []
    until = datetime.now(UTC) + timedelta(hours=1)
    stopped, _ = nightly.run_workers(cfg, {"base": "p"}, "n1", tmp_path, until, workers)
    assert stopped == "worker 2: exited 1: teardown failed"


def test_a_seeder_still_running_is_stopped_before_its_batch_is_removed(
    monkeypatch, tmp_path
):
    cfg = _cfg(
        WORKERS="2", AGENTS="2000", CONTROLLERS="100", BUCKET=f"file://{tmp_path}"
    )
    seeders = []

    class Stopped(Exception):
        pass

    def start(cfg, run_id, seed, extra, out):
        proc = _Proc()

        def wait():
            raise Stopped  # the pod's SIGTERM, arriving while it makes agents

        proc.wait = wait
        w = nightly.Worker(seed, run_id, tmp_path / f"{run_id}.log", proc)
        seeders.append(w)
        return w

    removed = []
    monkeypatch.setattr(nightly, "start", start)
    monkeypatch.setattr(nightly.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        nightly,
        "remove_population",
        lambda cfg, pop, out: removed.append(
            (dict(pop), list(seeders[0].proc.signals))
        ),
    )
    with pytest.raises(Stopped):
        nightly.seed_population(cfg, "n1", tmp_path)
    # Stopped first, then removed, with the batch it was making counted.
    assert removed == [({**removed[0][0], "batches": 1}, [signal.SIGINT])]
    assert s3_get(cfg, "population.json")["batches"] == 1


def test_a_pod_being_stopped_leaves_the_half_made_batches_to_the_next_night(
    monkeypatch, tmp_path
):
    cfg = _cfg(
        WORKERS="2", AGENTS="2000", CONTROLLERS="100", BUCKET=f"file://{tmp_path}"
    )

    def start(cfg, run_id, seed, extra, out):
        proc = _Proc()

        def wait():
            raise nightly.Interrupted("the pod was stopped (SIGTERM)")

        proc.wait = wait
        return nightly.Worker(seed, run_id, tmp_path / f"{run_id}.log", proc)

    removed = []
    monkeypatch.setattr(nightly, "start", start)
    monkeypatch.setattr(nightly.time, "sleep", lambda s: None)
    monkeypatch.setattr(nightly, "remove_population", lambda *a: removed.append(a))
    with pytest.raises(nightly.Interrupted):
        nightly.seed_population(cfg, "n1", tmp_path)
    pop = s3_get(cfg, "population.json")
    assert removed == [] and pop["batches"] == 1 and not pop["complete"]


def test_the_wait_ends_with_every_pod_ready_on_one_build_though_a_newer_one_waits(
    monkeypatch,
):
    states = iter(
        [
            {
                "ready": 11,
                "updated": 0,
                "pod_template_hash": ["h1"],
                "generation_seen": True,
            },
            {
                "ready": 12,
                "updated": 0,
                "pod_template_hash": ["h1"],
                "generation_seen": True,
            },
        ]
    )
    monkeypatch.setattr(nightly, "core_state", lambda cfg: next(states))
    monkeypatch.setattr(nightly.time, "sleep", lambda s: None)
    assert nightly.wait_core(_cfg(), 12, 1500)["ready"] == 12
