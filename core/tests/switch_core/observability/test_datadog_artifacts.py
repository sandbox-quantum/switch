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


# Every replica reports the same server-wide value for these, so a sum would
# multiply the reading by the number of pods.
_READ_WITH_MAX = (
    "switch.decision.pending",
    "switch.workos.cursor_age",
    "switch.workos.recheck.",
    "switch.workos.full_check.",
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
                f"{filename} reads {name} with {aggregation}. Every pod reports "
                "the same server-wide value, so only max gives the real reading."
            )


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


def test_monitors_on_the_workos_mirror_are_imported_only_where_it_runs() -> None:
    """Only a server with ORGANIZATION_DIRECTORY=workos reports the mirror's
    gauges, and these monitors fire on no data. `apply.sh` imports a monitor
    tagged requires:workos-directory only with WORKOS_DIRECTORY set, so one
    left untagged would fire for ever on every other server."""
    monitors = _load("monitors.json")
    assert isinstance(monitors, list)
    for monitor in monitors:
        reads_mirror = "switch.workos." in monitor["query"]
        tagged = "requires:workos-directory" in monitor["tags"]
        assert reads_mirror == tagged, monitor["name"]
