"""The provider gateway's figures in the status report are typed in Core:
today's calls, the cap and whether it's reached on the
machine, and each agent's AI calls today. Bounded whole numbers and a real
boolean only, so a box can't store anything else under these names."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import MAX_GATEWAY_CALLS, StatusReport

from .harness import fixture


def stored(report: dict[str, object]) -> dict[str, object]:
    return StatusReport.model_validate(report).model_dump(
        mode="json", exclude_unset=True
    )


def test_the_gateway_figures_are_accepted_and_kept() -> None:
    report = fixture("status_request.json")
    report["machine"].update(
        gateway_agents=3,
        gateway_refused=1,
        gateway_calls_today=40,
        gateway_capped=False,
        gateway_daily_cap=200,
    )
    report["agents"][0]["ai_calls_today"] = 12

    kept = stored(report)

    assert kept["machine"]["gateway_calls_today"] == 40
    assert kept["machine"]["gateway_daily_cap"] == 200
    assert kept["machine"]["gateway_capped"] is False
    assert kept["agents"][0]["ai_calls_today"] == 12


def test_a_report_without_them_is_still_accepted() -> None:
    kept = stored(fixture("status_request.json"))
    assert "gateway_daily_cap" not in kept["machine"]
    assert "ai_calls_today" not in kept["agents"][0]


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("gateway_calls_today", -1),
        ("gateway_calls_today", MAX_GATEWAY_CALLS + 1),
        ("gateway_calls_today", "40"),
        ("gateway_calls_today", 1.5),
        ("gateway_calls_today", True),
        ("gateway_daily_cap", 0),
        ("gateway_daily_cap", "200"),
        ("gateway_capped", "yes"),
        ("gateway_capped", 1),
        ("gateway_refused", -3),
    ],
)
def test_a_gateway_figure_that_cannot_be_one_is_refused(
    field: str, value: object
) -> None:
    report = fixture("status_request.json")
    report["machine"][field] = value
    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("value", [-1, MAX_GATEWAY_CALLS + 1, "12", 2.5, False])
def test_an_agent_s_ai_calls_that_cannot_be_a_count_are_refused(value: object) -> None:
    report = fixture("status_request.json")
    report["agents"][0]["ai_calls_today"] = value
    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)


@pytest.mark.parametrize("source", ["local", "workspace"])
def test_the_cap_s_source_is_one_of_two_fixed_values(source: str) -> None:
    report = fixture("status_request.json")
    report["machine"]["gateway_cap_source"] = source
    assert stored(report)["machine"]["gateway_cap_source"] == source


@pytest.mark.usefixtures("hosted_v2_on")
@pytest.mark.parametrize("source", ["admin", "", 1, None.__class__.__name__])
def test_any_other_cap_source_is_refused(source: object) -> None:
    report = fixture("status_request.json")
    report["machine"]["gateway_cap_source"] = source
    with pytest.raises(ValidationError):
        StatusReport.model_validate(report)
