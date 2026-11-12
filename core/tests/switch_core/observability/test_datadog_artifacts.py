"""The checked-in Datadog definitions must name metrics that exist.

Nothing else connects `deploy/observability/` to the code. A renamed metric
leaves the JSON valid and empty: panels draw nothing, and a monitor over an
absent series does not fire — so the alerting goes quiet rather than loud.

Same pattern as `bridges/agent/test_mcp_tool_surface.py`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from switch_core.observability.catalogue import CATALOGUE

_ARTIFACTS = Path(__file__).resolve().parents[4] / "deploy" / "observability"

# Any `switch.<dotted.name>` appearing in a query or a title.
_METRIC_REFERENCE = re.compile(r"\bswitch\.[a-z0-9_.]+\b")


def _referenced_metrics(document: object) -> set[str]:
    """Every metric name mentioned anywhere in a JSON document."""
    return set(_METRIC_REFERENCE.findall(json.dumps(document)))


def _load(name: str) -> object:
    return json.loads((_ARTIFACTS / name).read_text())


@pytest.mark.parametrize(
    "filename",
    [
        "dashboard.json",
        "multi-pod-dashboard.json",
        "monitors.json",
        "signal-board.json",
    ],
)
def test_every_metric_referenced_exists(filename: str) -> None:
    referenced = _referenced_metrics(_load(filename))
    # The morning report sends its own "posted" mark; that one is not core's.
    from_report = set(
        re.findall(
            r'"metric": "(switch\.[a-z0-9_.]+)"',
            (_ARTIFACTS / "daily_report.py").read_text(),
        )
    )
    unknown = sorted(referenced - set(CATALOGUE) - from_report)
    assert not unknown, (
        f"{filename} references {unknown}, which no longer exist in the metric "
        "catalogue. A Datadog monitor over an absent series does not fire, and "
        "a panel over one draws nothing — so this goes quiet rather than loud. "
        "Rename them here too, or drop them."
    )


def test_the_dashboard_covers_what_matters() -> None:
    """Not every metric needs a panel, but the ones left out should be deliberate."""
    referenced = _referenced_metrics(_load("dashboard.json"))
    deliberately_unpanelled = {
        # A curiosity rather than a signal; emitted for a memory question.
        "switch.runtime.gc_collections",
    }
    missing = sorted(set(CATALOGUE) - referenced - deliberately_unpanelled)
    assert not missing, (
        f"{missing} are emitted but appear on no dashboard panel. Add a panel, "
        "or add them to `deliberately_unpanelled` here with the reason."
    )


def test_monitors_are_individually_importable() -> None:
    """The README's import loop posts one monitor per call, so it must be a list."""
    monitors = _load("monitors.json")
    assert isinstance(monitors, list) and monitors

    names = [monitor["name"] for monitor in monitors]
    assert len(set(names)) == len(names), "two monitors share a name"

    for monitor in monitors:
        assert monitor["query"], monitor["name"]
        # Uniform, so one search finds every placeholder before import.
        assert "@REPLACE-WITH-NOTIFICATION-HANDLE" in monitor["message"], monitor[
            "name"
        ]


def test_launches_failing_counts_only_launch_and_wake_failures() -> None:
    """A machine whose owner left, that failed to stop, or that reported an
    error isn't a launch failing, so none of those page as one."""
    (monitor,) = [
        m
        for m in _load("monitors.json")  # type: ignore[union-attr]
        if m["name"].endswith("Hosted machine launches failing")
    ]
    assert (
        "reason IN (never_connected,wake_failed,not_scheduled,never_started)"
        in monitor["query"]
    )


def test_only_the_default_service_loads_the_shared_signal_board() -> None:
    """The signal board is one board under a fixed title. A run for any other
    deployment stops before it, so a test deployment can't overwrite it."""
    script = (_ARTIFACTS / "apply.sh").read_text()
    guard = script.index('if [[ "$SERVICE" != "switch-core" ]]; then')
    assert script.index("exit 0", guard) < script.index("file=signal-board.json")
    assert guard < script.index('existing_dashboards=$(dd GET "/dashboard")')


def test_every_monitor_watches_one_deployment_only() -> None:
    """Scoped to one deployment's `service`, the one tag Core sets that
    Datadog keeps, so a test slot or staging reporting into the same org can
    never fire another deployment's alerts. Never by `env`, which isn't set
    from `ENVIRONMENT` and can't separate deployments. `apply.sh` fills the blanks,
    and refuses to run without them."""
    for monitor in _load("monitors.json"):  # type: ignore[union-attr]
        query, name = monitor["query"], monitor["name"]
        assert "service:switch-core" not in query, name
        assert "env:" not in query, name
        if monitor["type"] == "log alert":
            # A log search is scoped inside `logs("...")`, by a leading term.
            search = re.match(r'logs\("(.*?)"\)\.index', query)
            assert search, name
            assert search.group(1).startswith("service:REPLACE-WITH-SERVICE "), (
                name,
                search.group(1),
            )
        else:
            scopes = [
                scope.split(",")
                for scope in re.findall(r"\{([^}]*)\}", query)
                if "service:" in scope
            ]
            assert scopes, name
            for scope in scopes:
                assert "service:REPLACE-WITH-SERVICE" in scope, (name, scope)
        assert "REPLACE-WITH-ENV" in name, name
        assert {"service:REPLACE-WITH-SERVICE", "env:REPLACE-WITH-ENV"} <= set(
            monitor["tags"]
        ), name
    script = (_ARTIFACTS / "apply.sh").read_text()
    assert "${SERVICE:?" in script
    assert "${ENV:?" in script
    assert "monitor=${monitor//REPLACE-WITH-SERVICE/$SERVICE}" in script
    assert "monitor=${monitor//REPLACE-WITH-ENV/$ENV}" in script
    # The default service is refused without an explicit opt-in, and no
    # deployment of ours is named in the public script.
    assert 'ALLOW_DEFAULT_SERVICE:-}" != "1"' in script
    assert "pilot" not in script


def test_the_dashboard_filters_by_service_not_env() -> None:
    """`env` can't separate deployments, so the dashboard picks one by
    `$service` only."""
    board = _load("dashboard.json")
    assert "$env" not in json.dumps(board)
    names = [v["name"] for v in board["template_variables"]]  # type: ignore[index]
    assert "service" in names and "env" not in names
    # `flint_env`, which a collector in front of Datadog keeps as a tag, is the
    # per-deployment filter beside `service`.
    assert "flint_env" in names
    assert "{$service}" not in json.dumps(board)


def test_the_refusals_alerts_split_guessing_from_retries() -> None:
    """The paging alert watches the bearer routes for guessed tokens only; a
    revoked controller's exchange, which looks like a guess, goes to a
    low-urgency alert of its own."""
    refusal_monitors = {
        m["name"]: m
        for m in _load("monitors.json")  # type: ignore[union-attr]
        if "switch.controller.credential_refusals" in m["query"]
    }
    assert len(refusal_monitors) == 2
    (paging,) = [m for m in refusal_monitors.values() if "route IN" in m["query"]]
    (routes,) = re.findall(r"route IN \(([^)]*)\)", paging["query"])
    assert set(routes.split(",")) == {"agent", "controller", "hosted_controller"}
    (reasons,) = re.findall(r"reason IN \(([^)]*)\)", paging["query"])
    assert set(reasons.split(",")) == {
        "invalid_credential",
        "missing_credential",
        "wrong",
        "missing",
    }
    (exchange,) = [m for m in refusal_monitors.values() if m is not paging]
    assert "route:management" in exchange["query"]
    assert exchange["priority"] > paging["priority"]


def test_no_monitor_names_one_deployment() -> None:
    """Each monitor is copied per deployment, so its text names none."""
    for monitor in _load("monitors.json"):  # type: ignore[union-attr]
        for word in ("switch-staging", "/switch/staging", "switch-prod"):
            assert word not in json.dumps(monitor), (monitor["name"], word)


# Every replica reports the same server-wide value for these, so a sum would
# multiply the reading by the number of pods.
# Gauges whose every series carries the same reading: server-wide values every
# pod reports, and the hosted gauges, which one process reports but which can
# reach Datadog as one series per path through a collector in front of it. `sum:`
# would add the copies together; only `max:` gives the real reading.
_READ_WITH_MAX = (
    "switch.decision.pending",
    "switch.hosted.boxes_expected",
    "switch.hosted.boxes_reporting",
    "switch.hosted.agents",
    "switch.hosted.sessions",
    "switch.hosted.provider_login_problems",
)


@pytest.mark.parametrize(
    "filename",
    [
        "dashboard.json",
        "multi-pod-dashboard.json",
        "monitors.json",
        "signal-board.json",
    ],
)
def test_server_wide_gauges_are_read_with_max(filename: str) -> None:
    text = json.dumps(_load(filename))
    for prefix in _READ_WITH_MAX:
        for aggregation, name in re.findall(
            rf"\b([a-z0-9]+):({re.escape(prefix)}[a-z0-9_.]*)\{{", text
        ):
            assert aggregation == "max", (
                f"{filename} reads {name} with {aggregation}. Every series of it "
                "carries the same reading, so only max gives the real one."
            )


@pytest.mark.parametrize(
    "filename", ["dashboard.json", "multi-pod-dashboard.json", "signal-board.json"]
)
def test_no_toplist_request_carries_an_aggregator(filename: str) -> None:
    """Datadog refuses to import a toplist whose request has `aggregator`
    ("Invalid widget definition ... 'aggregator' was unexpected"). A toplist
    says how to rank in its query instead: `top(<query>, 10, 'last', 'desc')`.
    Query values keep their `aggregator`, which Datadog accepts there."""
    board = _load(filename)
    for chart in _charts(board["widgets"]):  # type: ignore[index]
        if chart["type"] != "toplist":
            continue
        for request in chart.get("requests", []):
            assert "aggregator" not in request, (filename, chart.get("title"))


def _charts(widgets: list[dict]) -> list[dict]:
    """Every widget definition on a dashboard, groups opened up."""
    found = []
    for widget in widgets:
        definition = widget["definition"]
        if definition["type"] == "group":
            found += _charts(definition["widgets"])
        else:
            found.append(definition)
    return found


def test_the_signal_board_stays_readable_at_a_glance() -> None:
    """Working memory holds three to seven things, so a chart that draws more
    lines than that is read by going back and forth to the legend. The board
    is for seeing, so it keeps to five."""
    board = _load("signal-board.json")
    assert isinstance(board, dict)
    for chart in _charts(board["widgets"]):
        series = sum(
            len(request.get("formulas", [])) for request in chart.get("requests", [])
        )
        assert series <= 5, f"{chart.get('title')} draws {series} series"
