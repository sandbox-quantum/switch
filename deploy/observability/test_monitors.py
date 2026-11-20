"""monitors.json's checks, and where apply.sh routes each monitor.

apply.sh runs in DRY_RUN without Datadog keys, so nothing here reaches Datadog.
"""

from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
from pathlib import Path

import check_monitors
import pytest

HERE = Path(__file__).parent
MONITORS = json.loads((HERE / "monitors.json").read_text())

HANDLES = {
    "NOTIFY": "@slack-example-ops",
    "NOTIFY_SECURITY": "@slack-example-security",
    "NOTIFY_SECURITY_PAGE": "@pagerduty-example-security",
}


def monitor(
    name: str,
    category: str,
    priority: int,
    query: str = "sum(last_5m):sum:switch.example{service:REPLACE-WITH-SERVICE} > 1",
) -> dict:
    return {
        "name": f"[Switch REPLACE-WITH-ENV] {name}",
        "type": "query alert",
        "query": query,
        "message": f"{name} fired.\n\n@REPLACE-WITH-NOTIFICATION-HANDLE",
        "tags": [
            "service:REPLACE-WITH-SERVICE",
            "env:REPLACE-WITH-ENV",
            "team:switch",
            "tier:now",
            f"category:{category}",
        ],
        "options": {"thresholds": {"critical": 1}},
        "priority": priority,
    }


ROUTED = [
    monitor("ops p1", "ops", 1),
    monitor("ops p4", "ops", 4),
    monitor("security p1", "security", 1),
    monitor("security p2", "security", 2),
    monitor("security p3", "security", 3),
    monitor("security p5", "security", 5),
]


def test_the_monitors_in_this_directory_pass():
    assert check_monitors.problems_in(MONITORS) == []


def test_the_security_monitors_are_tagged_as_such():
    security = {
        m["name"].split("] ", 1)[1]
        for m in MONITORS
        if "category:security" in m["tags"]
    }
    assert {
        "Controller credential refusals rising",
        "Controller token exchanges and enrolments refused",
        "Password sign-in failures rising",
    } <= security


def broken(change) -> list[str]:
    monitors = copy.deepcopy(ROUTED)
    change(monitors[0])
    return check_monitors.problems_in(monitors)


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda m: m.pop("priority"), "missing 'priority'"),
        (lambda m: m.update(priority=0), "priority must be an integer"),
        (lambda m: m["tags"].remove("category:ops"), "exactly one category: tag"),
        (lambda m: m["tags"].append("category:security"), "exactly one category: tag"),
        (lambda m: m["tags"].remove("team:switch"), "exactly one team: tag"),
        (
            lambda m: m["tags"].remove("service:REPLACE-WITH-SERVICE"),
            "missing tag 'service:REPLACE-WITH-SERVICE'",
        ),
        (
            lambda m: m["tags"].__setitem__(4, "category:billing"),
            "unknown category 'billing'",
        ),
        (lambda m: m.update(message="no handle at all"), "exactly once"),
        (
            lambda m: m.update(message=m["message"] + " @slack-somewhere"),
            "names '@slack-somewhere'",
        ),
        (
            lambda m: m.update(message="@pagerduty-somebody"),
            "names '@pagerduty-somebody'",
        ),
        (
            lambda m: m.update(
                query=m["query"].replace("REPLACE-WITH-SERVICE", "REPLACE-WITH-SERVCE")
            ),
            "unknown placeholder 'REPLACE-WITH-SERVCE'",
        ),
        (lambda m: m.update(name="Unprefixed"), "name must start with"),
        (
            lambda m: m.update(
                query="sum(last_10m):sum:switch.auth.sign_in_failures{service:REPLACE-WITH-SERVICE} > 20"
            ),
            "must be tagged 'category:security'",
        ),
        (
            lambda m: m.update(
                query='logs("service:switch-core @switch.event:security.login_failed").index("*").rollup("count").last("5m") > 5'
            ),
            "must be tagged 'category:security'",
        ),
    ],
)
def test_a_broken_monitor_is_refused(change, expected):
    problems = broken(change)
    assert any(expected in p for p in problems), problems


def test_a_duplicate_name_is_refused():
    assert any(
        "duplicate name" in p
        for p in check_monitors.problems_in([ROUTED[0], ROUTED[0]])
    )


def test_log_facets_in_a_query_are_not_handles():
    m = monitor(
        "log alert",
        "security",
        3,
        query='logs("@switch.event:security.example").index("*").rollup("count").last("5m") > 5',
    )
    assert check_monitors.problems_in([m]) == []


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    for name in ("apply.sh", "check_monitors.py", "signal-board.json"):
        shutil.copy(HERE / name, tmp_path / name)
    (tmp_path / "monitors.json").write_text(json.dumps(ROUTED))
    return tmp_path


def run_apply(
    workdir: Path, **overrides: str | None
) -> subprocess.CompletedProcess[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("DD_", "NOTIFY"))}
    env.update(HANDLES, DRY_RUN="1", SERVICE="switch-core-example", ENV="example")
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return subprocess.run(
        ["bash", str(workdir / "apply.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def handles_by_name(stdout: str) -> dict[str, list[str]]:
    payloads = [json.loads(line) for line in stdout.splitlines()]
    return {
        p["name"].split("] ", 1)[1]: p["message"].rsplit("\n", 1)[1].split()
        for p in payloads
    }


def test_monitors_are_routed_by_category_and_priority(workdir):
    result = run_apply(workdir)
    assert result.returncode == 0, result.stderr
    assert handles_by_name(result.stdout) == {
        "ops p1": ["@slack-example-ops"],
        "ops p4": ["@slack-example-ops"],
        "security p1": ["@slack-example-security", "@pagerduty-example-security"],
        "security p2": ["@slack-example-security", "@pagerduty-example-security"],
        "security p3": ["@slack-example-security"],
        "security p5": ["@slack-example-security"],
    }
    assert "REPLACE-WITH" not in result.stdout
    assert all(
        json.loads(line)["name"].startswith("[Switch example] ")
        for line in result.stdout.splitlines()
    )


def test_a_variable_may_hold_several_handles(workdir):
    result = run_apply(
        workdir, NOTIFY_SECURITY_PAGE="@pagerduty-example-security @opsgenie-example"
    )
    assert result.returncode == 0, result.stderr
    assert handles_by_name(result.stdout)["security p1"] == [
        "@slack-example-security",
        "@pagerduty-example-security",
        "@opsgenie-example",
    ]


def test_a_deployment_that_pages_its_channel_names_it_once(workdir):
    channel = "@slack-example-ops"
    result = run_apply(
        workdir, NOTIFY=channel, NOTIFY_SECURITY=channel, NOTIFY_SECURITY_PAGE=channel
    )
    assert result.returncode == 0, result.stderr
    assert set(map(tuple, handles_by_name(result.stdout).values())) == {(channel,)}


def test_the_real_monitors_render_with_no_placeholder_left():
    result = run_apply(HERE)
    assert result.returncode == 0, result.stderr
    assert len(result.stdout.splitlines()) == len(MONITORS)
    assert "REPLACE-WITH" not in result.stdout


@pytest.mark.parametrize("var", ["NOTIFY", "NOTIFY_SECURITY", "NOTIFY_SECURITY_PAGE"])
@pytest.mark.parametrize("value", [None, "", "   "])
def test_a_missing_handle_is_refused(workdir, var, value):
    result = run_apply(workdir, **{var: value})
    assert result.returncode != 0
    assert var in result.stderr
    assert result.stdout == ""


@pytest.mark.parametrize(
    "value", ["slack-example", "@REPLACE-WITH-NOTIFICATION-HANDLE", "@ok no-at"]
)
def test_a_malformed_handle_is_refused(workdir, value):
    result = run_apply(workdir, NOTIFY_SECURITY=value)
    assert result.returncode != 0
    assert "NOTIFY_SECURITY" in result.stderr
    assert result.stdout == ""


def test_a_monitor_failing_its_checks_stops_everything(workdir):
    monitors = copy.deepcopy(ROUTED)
    monitors[-1]["tags"].remove("category:security")
    (workdir / "monitors.json").write_text(json.dumps(monitors))
    result = run_apply(workdir)
    assert result.returncode != 0
    assert "nothing was sent" in result.stderr
    assert result.stdout == ""


def test_a_placeholder_left_in_the_dashboard_stops_everything(workdir):
    (workdir / "signal-board.json").write_text(
        json.dumps(
            {"title": "board", "widgets": [{"q": "service:REPLACE-WITH-SERVICE"}]}
        )
    )
    result = run_apply(workdir)
    assert result.returncode != 0
    assert "placeholder" in result.stderr
    assert result.stdout == ""


def test_keys_are_required_outside_a_dry_run(workdir):
    result = run_apply(workdir, DRY_RUN=None)
    assert result.returncode != 0
    assert "DD_API_KEY" in result.stderr
