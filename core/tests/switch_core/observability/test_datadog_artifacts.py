"""The checked-in Datadog definitions must name metrics that exist.

`deploy/observability/` holds a dashboard and ten monitors as JSON, and nothing
else connects them to the code. A metric renamed in the catalogue leaves them
syntactically valid and semantically empty: panels draw nothing, monitors
evaluate no series, and — because a Datadog monitor over an absent series does
not fire — the alerting goes quiet rather than loud. That is the failure this
whole package exists to prevent, so it is pinned here.

The same pattern as `bridges/agent/test_mcp_tool_surface.py`, which compares
the three connector skills against the tools actually registered.
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
    return {
        name
        for name in _METRIC_REFERENCE.findall(json.dumps(document))
        # `switch.db.pool.in_use` and friends are metrics; `switch-core` is a
        # service name and does not match, but a trailing word from prose
        # might, so only exact catalogue-shaped names are considered below.
    }


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
    """Not every metric needs a panel, but the ones left out should be deliberate.

    Listing the exceptions here means adding a metric without a panel is a
    decision someone writes down, rather than something nobody notices.
    """
    referenced = _referenced_metrics(_load("dashboard.json"))
    deliberately_unpanelled = {
        # A curiosity for a service like this one, not a signal. Kept emitted
        # for the day someone is chasing a memory question.
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
        # A placeholder that imports cleanly and notifies nobody is the
        # failure mode the README warns about; keeping it uniform means one
        # search finds every one of them.
        assert "@REPLACE-WITH-NOTIFICATION-HANDLE" in monitor["message"], monitor[
            "name"
        ]
