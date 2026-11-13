"""A box reports its valve's memory problem as an optional field on the
status report's `machine`: "unprotected" when the box valve has never read the
box's memory, "failing" while its readings fail after good ones. Core must keep
either value when it stores the report, take a report without it (readings are
fine, or the controller is older), and refuse anything else, so an operator view
never shows a value a box made up."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import StatusReport

from .harness import fixture


@pytest.mark.parametrize("value", ["unprotected", "failing"])
def test_each_value_is_accepted_and_kept_in_the_stored_report(value: str) -> None:
    report = fixture("status_request.json")
    report["machine"]["valve_memory"] = value

    # The same dump the service stores the report with.
    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    assert stored["machine"]["valve_memory"] == value


def test_a_report_without_it_is_accepted_and_reads_none() -> None:
    report = fixture("status_request.json")
    report["machine"].pop("valve_memory", None)

    parsed = StatusReport.model_validate(report)

    assert parsed.machine.valve_memory is None
    assert (
        "valve_memory"
        not in parsed.model_dump(mode="json", exclude_unset=True)["machine"]
    )


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("value", ["ok", "UNPROTECTED", "", 1, True, ["failing"]])
def test_any_other_value_is_refused(value: object) -> None:
    report = fixture("status_request.json")
    report["machine"]["valve_memory"] = value

    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)
