"""A box says which disk its disk figures measure, as an optional field on the
status report's `machine`: "workspace" when its launcher measured the agents'
own volume, "unknown" otherwise. Core keeps it, takes a report without it (an older controller,
whose figure is its own data folder), and stores anything else as "unknown",
so the apps never show a disk a box only claims is the workspace, and a bad
mark never costs the box its report."""

from __future__ import annotations

import pytest

from switch_core.management.schemas import StatusReport

from .harness import fixture


@pytest.mark.parametrize("value", ["workspace", "unknown"])
def test_each_value_is_accepted_and_kept_in_the_stored_report(value: str) -> None:
    report = fixture("status_request.json")
    report["machine"]["disk_scope"] = value

    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    assert stored["machine"]["disk_scope"] == value


def test_a_report_without_it_is_accepted_and_reads_none() -> None:
    report = fixture("status_request.json")
    report["machine"].pop("disk_scope", None)

    parsed = StatusReport.model_validate(report)

    assert parsed.machine.disk_scope is None
    assert (
        "disk_scope"
        not in parsed.model_dump(mode="json", exclude_unset=True)["machine"]
    )


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    "value", ["system", "WORKSPACE", "Unknown", "", 1, True, ["workspace"], {"a": 1}]
)
def test_any_other_value_is_stored_as_unknown_never_refused(value: object) -> None:
    """A bad mark must not cost the box its whole report."""
    report = fixture("status_request.json")
    report["machine"]["disk_scope"] = value

    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    assert stored["machine"]["disk_scope"] == "unknown"
    assert (
        stored["machine"]["disk_total_bytes"] == report["machine"]["disk_total_bytes"]
    )
