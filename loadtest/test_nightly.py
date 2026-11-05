"""The nightly run's arithmetic and report. No requests, no cluster."""

from __future__ import annotations

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
    "LOADTEST_NAMESPACE": "switch-staging",
    "LOADTEST_DEPLOYMENT": "switch-staging-switch-core",
    "LOADTEST_API_URL": "http://switch-staging-switch-core.switch-staging.svc:8000",
    "LOADTEST_CLUSTER": "switch",
    "LOADTEST_CORE_NODEGROUP": "staging-",
    "LOADTEST_HARNESS_NODEGROUP": "loadtest-harness-",
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
            "--namespace", "switch-staging", "--steps", "1000", "--controllers", "50",
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
    assert sized == [("staging-", 1), ("loadtest-harness-", 0)]
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
