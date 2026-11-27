"""The provider gateway's figures in the status report are typed in Core: the
agents it fronts and the calls it refused, bounded whole numbers only, so a box
can't store anything else under these names. What boxes made before the daily
call cap and the memory guard were removed still send is taken out of the
report: neither stored nor refused."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import (
    MAX_GATEWAY_REFUSED,
    RETIRED_AGENT_STATUS_FIELDS,
    RETIRED_MACHINE_STATUS_FIELDS,
    StatusReport,
)

from .harness import fixture


def stored(report: dict[str, object]) -> dict[str, object]:
    return StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )


def _an_old_box_s_report() -> dict:
    """A report from a box made while it had a daily call cap and a memory guard."""
    report = fixture("status_request.json")
    report["machine"].update(
        gateway_agents=3,
        gateway_refused=1,
        gateway_calls_today=40,
        gateway_capped=False,
        gateway_daily_cap=200,
        gateway_cap_source="workspace",
        guard_stops=2,
        memory_note="sustained",
        memory_note_box_bytes=1_000,
        memory_note_shmem_bytes=10,
    )
    report["agents"][0]["ai_calls_today"] = 12
    return report


@pytest.mark.usefixtures("hosted_v2_on")
def test_the_gateway_figures_are_accepted_and_kept() -> None:
    kept = stored(_an_old_box_s_report())
    assert kept["machine"]["gateway_agents"] == 3
    assert kept["machine"]["gateway_refused"] == 1


@pytest.mark.usefixtures("hosted_v2_on")
def test_an_old_box_s_cap_and_guard_figures_are_accepted_and_not_stored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    kept = stored(_an_old_box_s_report())
    for name in RETIRED_MACHINE_STATUS_FIELDS:
        assert name not in kept["machine"]
    for name in RETIRED_AGENT_STATUS_FIELDS:
        assert name not in kept["agents"][0]
    assert not [r for r in caplog.records if r.levelname in ("WARNING", "ERROR")]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    "value", [-1, 1_000_000_001, "40", 1.5, True, None, {"x": 1}, "a sentence"]
)
def test_whatever_an_old_box_sends_under_a_retired_name_never_costs_its_report(
    value: object,
) -> None:
    report = fixture("status_request.json")
    for name in RETIRED_MACHINE_STATUS_FIELDS:
        report["machine"][name] = value
    for name in RETIRED_AGENT_STATUS_FIELDS:
        report["agents"][0][name] = value
    kept = stored(report)
    assert not set(RETIRED_MACHINE_STATUS_FIELDS) & set(kept["machine"])
    assert not set(RETIRED_AGENT_STATUS_FIELDS) & set(kept["agents"][0])


def test_with_v2_off_a_report_is_kept_as_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    from switch_core import hosted_v2

    monkeypatch.setattr(hosted_v2, "_process_on", False)
    kept = stored(_an_old_box_s_report())
    assert kept["machine"]["gateway_daily_cap"] == 200
    assert kept["machine"]["memory_note"] == "sustained"
    assert kept["agents"][0]["ai_calls_today"] == 12


def test_a_report_without_them_is_still_accepted() -> None:
    kept = stored(fixture("status_request.json"))
    assert "gateway_refused" not in kept["machine"]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("gateway_refused", -3),
        ("gateway_refused", MAX_GATEWAY_REFUSED + 1),
        ("gateway_refused", "1"),
        ("gateway_refused", True),
        ("gateway_agents", -1),
        ("gateway_agents", 1.5),
    ],
)
def test_a_gateway_figure_that_cannot_be_one_is_refused(
    field: str, value: object
) -> None:
    report = fixture("status_request.json")
    report["machine"][field] = value
    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)
