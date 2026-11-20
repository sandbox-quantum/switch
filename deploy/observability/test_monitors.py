"""monitors.json's checks, and where apply.sh routes each monitor.

apply.sh runs in DRY_RUN without Datadog keys, so nothing here reaches Datadog.
"""

from __future__ import annotations

import copy
import json
import os
import re
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
        *DETECTION_RULES,
    } <= security


# The security detection rules: one actor's suspicious activity, read from
# the security event stream (`core/switch_core/security_events.py`).
DETECTION_RULES = {
    "Security: an agent is posting a burst of messages": 3,
    "Security: an agent is reading many rooms": 2,
    "Security: one actor is adding many room members": 3,
    "Security: one actor is moving many files": 3,
    "Security: an agent is asking for many service tokens": 3,
    "Security: Switch Trust blocked or redacted a message": 3,
    "Security: an agent was given more power": 3,
    "Security: a platform operator acted in a workspace": 4,
    "Security: an API key was revealed": 4,
    "Security: sign-ins failing from one address": 3,
    "Security: sign-ins failing for one account": 3,
    "Security: one caller keeps tripping the refusal breaker": 3,
    "Security: an agent or person was suspended": 4,
}
# Actions another change is adding to the audit log; the rules match them by
# name so they alert from the first one written.
PENDING_ACTIONS = {
    "agent.suspended",
    "user.suspended",
}
CORE = HERE.parent.parent / "core" / "switch_core"


def detection_rules() -> dict[str, dict]:
    return {
        m["name"].split("] ", 1)[1]: m
        for m in MONITORS
        if m["name"].split("] ", 1)[1] in DETECTION_RULES
    }


def test_every_detection_rule_is_there_at_its_priority():
    rules = detection_rules()
    assert {name: m["priority"] for name, m in rules.items()} == DETECTION_RULES


@pytest.mark.parametrize("name", sorted(DETECTION_RULES))
def test_a_detection_rule_is_a_log_alert_per_actor_that_says_how_to_stop_it(name):
    rule = detection_rules()[name]
    assert rule["type"] == "log alert"
    assert "category:security" in rule["tags"]
    assert '.by("@' in rule["query"], "grouped by the actor, not counted overall"
    assert rule["query"].startswith('logs("service:REPLACE-WITH-SERVICE ')
    message = rule["message"]
    assert "{{#is_alert}}" in message and "{{/is_alert}}" in message
    assert "{{#is_recovery}}" in message and "{{/is_recovery}}" in message
    alert = message.split("{{#is_alert}}", 1)[1].split("{{/is_alert}}", 1)[0]
    assert "switch-suspend" in alert and "suspend runbook" in alert
    assert message.endswith("\n\n@REPLACE-WITH-NOTIFICATION-HANDLE")
    assert rule["options"]["enable_logs_sample"] is True


def _names_in(source: Path) -> set[str]:
    return set(re.findall(r'^\s+[A-Z_]+ = "([a-z_.]+)"', source.read_text(), re.M))


def test_the_rules_name_only_events_and_actions_core_writes():
    """A misspelt event or action matches nothing, and a log monitor that
    matches nothing sits healthy for ever."""
    signals = _names_in(CORE / "security_events.py")
    actions = _names_in(CORE / "db" / "audit.py")
    assert {"agent.message_sent", "auth.sign_in_failed"} <= signals
    assert {"platform.access", "room.member_added"} <= actions
    for name, rule in detection_rules().items():
        query = rule["query"]
        for group in re.findall(r'@switch\.event:(\([^)]*\)|[^"\s)]+)', query):
            for event in re.findall(r"security\.([a-z_.]*[a-z_])", group):
                assert event in signals, (name, event)
        for group in re.findall(r'@switch\.action:(\([^)]*\)|[^"\s)]+)', query):
            for action in re.split(r"\s+OR\s+", group.strip("()")):
                assert action in actions | PENDING_ACTIONS, (name, action)


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
        (
            lambda m: m.update(
                query='logs("service:switch-core @switch.event:(security.a OR security.b)").index("*").rollup("count").by("@switch.agent_id").last("5m") > 5'
            ),
            "must be tagged 'category:security'",
        ),
        (
            lambda m: m.update(
                query='logs("service:switch-core @switch.action:api_key.revealed").index("*").rollup("count").by("@switch.actor_user_id").last("5m") > 0'
            ),
            "must be tagged 'category:security'",
        ),
        (
            lambda m: m.update(
                query='logs("service:switch-core @security_details.outcome:blocked").index("*").rollup("count").last("5m") > 0'
            ),
            "must be tagged 'category:security'",
        ),
        (
            lambda m: m.update(
                query='logs("service:switch-core logger.name:switch_core.security").index("*").rollup("count").last("5m") > 0'
            ),
            "must be tagged 'category:security'",
        ),
        (
            lambda m: m.update(
                message="{{[@switch.agent_id].name}} [@slack-somewhere] @REPLACE-WITH-NOTIFICATION-HANDLE"
            ),
            "names '@slack-somewhere'",
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


def test_a_facet_value_in_a_message_is_not_a_handle():
    m = monitor("log alert", "security", 3)
    m["message"] = (
        "{{#is_alert}}Agent {{[@switch.agent_id].name}} in {{ [@switch.room_id].name }}"
        "{{/is_alert}}\n\n@REPLACE-WITH-NOTIFICATION-HANDLE"
    )
    assert check_monitors.problems_in([m]) == []


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
    result = run_apply(HERE, WORKOS_DIRECTORY="1")
    assert result.returncode == 0, result.stderr
    assert len(result.stdout.splitlines()) == len(MONITORS)
    assert "REPLACE-WITH" not in result.stdout


def test_the_workos_directory_monitors_are_left_out_unless_asked_for():
    workos = {
        m["name"].split("] ", 1)[1]
        for m in MONITORS
        if "requires:workos-directory" in m["tags"]
    }
    assert workos
    result = run_apply(HERE)
    assert result.returncode == 0, result.stderr
    assert workos.isdisjoint(handles_by_name(result.stdout))


def test_the_detection_rules_reach_the_security_channel_and_only_p2_pages():
    result = run_apply(HERE)
    assert result.returncode == 0, result.stderr
    routed = handles_by_name(result.stdout)
    for name, priority in DETECTION_RULES.items():
        expected = ["@slack-example-security"]
        if priority <= 2:
            expected.append("@pagerduty-example-security")
        assert routed[name] == expected, name


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
