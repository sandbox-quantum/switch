"""The status report's machine extras are typed in Core: the box valve's host counts are bounded whole numbers, and the memory
guard's note is a fixed code with its figures, never text, so an operator view
can only show what Core knows. An older controller still sends the note as a
sentence: that note is dropped and counted, never stored, and the rest of the
report is kept, so Core never goes blind to a box on an older controller."""

from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError

from switch_core.management import service
from switch_core.management.schemas import (
    MAX_MEMINFO_BYTES,
    MAX_VALVE_HOSTS,
    StatusReport,
)

from .harness import fixture

GIB = 1024**3


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


@pytest.mark.parametrize("code", ["unexplained", "sustained"])
def test_each_memory_note_code_is_kept_with_its_figures(code: str) -> None:
    report = fixture("status_request.json")
    report["machine"]["memory_note"] = code
    report["machine"]["memory_note_box_bytes"] = 5 * GIB
    report["machine"]["memory_note_shmem_bytes"] = 4 * GIB

    machine = stored(report)["machine"]

    assert machine["memory_note"] == code
    assert machine["memory_note_box_bytes"] == 5 * GIB
    assert machine["memory_note_shmem_bytes"] == 4 * GIB


def test_a_report_without_a_note_reads_none_and_stores_none() -> None:
    report = fixture("status_request.json")
    report["machine"].pop("memory_note", None)

    parsed = StatusReport.model_validate(report)

    assert parsed.machine.memory_note is None
    assert parsed.machine._dropped_old_note is False
    assert "memory_note" not in stored(report)["machine"]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    "old",
    [
        "The box is at 5.8 GiB of 6.0 GiB, and no agent's processes explain it, "
        "so the memory guard stopped no one.",
        "UNEXPLAINED",
        "",
        5,
        True,
    ],
)
def test_an_older_controllers_note_is_dropped_and_the_rest_kept(old: object) -> None:
    report = fixture("status_request.json")
    report["machine"]["memory_note"] = old
    report["machine"]["valve_hosts"] = 5

    parsed = StatusReport.model_validate(report)
    machine = stored(report)["machine"]

    # Dropped, never stored, and flagged for counting.
    assert parsed.machine.memory_note is None
    assert parsed.machine._dropped_old_note is True
    assert "memory_note" not in machine
    # The rest of the report is intact.
    assert machine["valve_hosts"] == 5
    assert machine["sessions_max"] == report["machine"]["sessions_max"]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("value", [-1, MAX_MEMINFO_BYTES + 1, 1.5, "5368709120", True])
@pytest.mark.parametrize("field", ["memory_note_box_bytes", "memory_note_shmem_bytes"])
def test_a_note_figure_that_cannot_be_a_reading_is_refused(
    field: str, value: object
) -> None:
    report = fixture("status_request.json")
    report["machine"]["memory_note"] = "unexplained"
    report["machine"][field] = value

    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)


def test_a_dropped_note_is_logged_once_per_controller_by_id_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    service._OLD_NOTE_DROPPED.clear()
    with caplog.at_level(logging.INFO, logger=service.__name__):
        service._note_dropped("controller-a")
        service._note_dropped("controller-a")
        service._note_dropped("controller-b")

    lines = [
        r.getMessage()
        for r in caplog.records
        if "old free-text memory note" in r.getMessage()
    ]
    assert len(lines) == 2
    assert "controller-a" in lines[0]
    assert "controller-b" in lines[1]
    service._OLD_NOTE_DROPPED.clear()
