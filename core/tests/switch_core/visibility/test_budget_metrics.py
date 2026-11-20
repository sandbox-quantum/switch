"""Which budgets the API creates: awake minutes yes; the hosted daily
cap (`hosted_ai_calls`) only as the gateway's cap (every agent, no model, 24
hours, 1 to 1,000,000), which the gateway enforces and Core never does."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.db.models import BUDGET_METRICS, UsageMetric
from switch_core.gateway.schemas import BudgetCreateRequest

# v2's metrics: with hosted agents v2 off they are refused as upstream refused
# them (`test_hosted_v2_extras.py`).
pytestmark = pytest.mark.usefixtures("hosted_v2_on")


def _request(metric: str, model: str = "") -> BudgetCreateRequest:
    return BudgetCreateRequest(
        agent_id=None,
        metric=metric,
        model=model,
        amount_limit=600,
        period_hours=720,  # type: ignore[arg-type]
    )


def test_an_awake_time_budget_is_accepted() -> None:
    assert _request("awake_minutes").metric is UsageMetric.AWAKE_MINUTES


def _daily_cap(**changes: object) -> BudgetCreateRequest:
    terms: dict[str, object] = {
        "agent_id": None,
        "metric": "hosted_ai_calls",
        "model": "",
        "amount_limit": 300,
        "period_hours": 24,
    }
    terms.update(changes)
    return BudgetCreateRequest(**terms)  # type: ignore[arg-type]


def test_the_hosted_daily_cap_is_created_only_as_the_gateway_s_cap() -> None:
    """Still never enforced by Core (not in BUDGET_METRICS),
    but the admin can set it as one number a day for every agent."""
    assert UsageMetric.HOSTED_AI_CALLS not in BUDGET_METRICS
    assert _daily_cap().amount_limit == 300
    assert _daily_cap(amount_limit=1_000_000).amount_limit == 1_000_000


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"agent_id": "agent-1"}, "every agent"),
        ({"model": "claude-x"}, "every agent"),
        ({"period_hours": 720}, "per day"),
        ({"period_hours": 1}, "per day"),
        ({"amount_limit": 1_000_001}, "1 to 1000000"),
    ],
)
def test_anything_else_on_the_daily_cap_is_refused(
    changes: dict[str, object], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        _daily_cap(**changes)


@pytest.mark.parametrize("metric", ["messages", "turns", "awake_minutes"])
def test_metrics_not_counted_per_model_name_no_model(metric: str) -> None:
    with pytest.raises(ValidationError, match="cannot name a model"):
        _request(metric, model="claude-x")


def test_token_budgets_can_still_name_a_model() -> None:
    assert _request("input_tokens", model="claude-x").model == "claude-x"
