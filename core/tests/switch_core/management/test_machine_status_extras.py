"""The status report's machine extras are typed in Core: the box valve's host
counts are bounded whole numbers, so an operator view can only show what Core
knows."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import (
    MAX_VALVE_HOSTS,
    StatusReport,
)

from .harness import fixture


def stored(report: dict[str, object]) -> dict[str, object]:
    # The same dump the service stores the report with.
    return StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )


def test_the_valve_host_counts_are_accepted_and_kept() -> None:
    report = fixture("status_request.json")
    report["machine"]["valve_hosts"] = 5
    report["machine"]["valve_hosts_joined"] = 4

    machine = stored(report)["machine"]

    assert machine["valve_hosts"] == 5
    assert machine["valve_hosts_joined"] == 4


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("value", [-1, MAX_VALVE_HOSTS + 1, 1.5, "5", True])
@pytest.mark.parametrize("field", ["valve_hosts", "valve_hosts_joined"])
def test_a_host_count_that_cannot_be_one_is_refused(field: str, value: object) -> None:
    report = fixture("status_request.json")
    report["machine"][field] = value

    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)
