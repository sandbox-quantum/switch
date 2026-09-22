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


@pytest.mark.parametrize("filename", ["dashboard.json", "monitors.json"])
def test_every_metric_referenced_exists(filename: str) -> None:
    referenced = _referenced_metrics(_load(filename))
    unknown = sorted(referenced - set(CATALOGUE))
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
