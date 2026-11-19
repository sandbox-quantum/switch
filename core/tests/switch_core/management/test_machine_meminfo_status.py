"""A box reports its own memory from /proc/meminfo (`mem_anon_bytes`, AnonPages,
and `mem_cached_bytes`, Cached) as optional fields on the status report's
`machine`, for the cost model and the live page. Core must keep them when it
stores the report, take a report without them (a macOS controller, or one older
than these fields), and refuse a figure that cannot be a reading."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import MAX_MEMINFO_BYTES, StatusReport

from .harness import fixture

# Box A at 11:50Z on 27 Oct, all five agents parked.
ANON = 940_496 * 1024
CACHED = 571_544 * 1024


def test_meminfo_figures_are_accepted_and_kept_in_the_stored_report() -> None:
    report = fixture("status_request.json")
    report["machine"]["mem_anon_bytes"] = ANON
    report["machine"]["mem_cached_bytes"] = CACHED

    # The same dump the service stores the report with.
    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    assert stored["machine"]["mem_anon_bytes"] == ANON
    assert stored["machine"]["mem_cached_bytes"] == CACHED


def test_a_report_without_them_is_accepted_and_stored_without_them() -> None:
    report = fixture("status_request.json")
    report["machine"].pop("mem_anon_bytes", None)
    report["machine"].pop("mem_cached_bytes", None)

    stored = StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )

    assert "mem_anon_bytes" not in stored["machine"]
    assert "mem_cached_bytes" not in stored["machine"]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    "value",
    [-1, MAX_MEMINFO_BYTES + 1, 1.5, "940496 kB", True],
)
@pytest.mark.parametrize("field", ["mem_anon_bytes", "mem_cached_bytes"])
def test_a_figure_that_cannot_be_a_reading_is_refused(
    field: str, value: object
) -> None:
    report = fixture("status_request.json")
    report["machine"][field] = value

    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)
