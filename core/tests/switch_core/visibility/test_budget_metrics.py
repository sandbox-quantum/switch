"""Which budgets the API creates: awake minutes yes; `hosted_ai_calls`, the
removed daily AI cap's metric, never."""

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


@pytest.mark.parametrize(
    ("amount_limit", "period_hours"), [(300, 24), (1_000_000, 24), (600, 720)]
)
def test_a_hosted_ai_calls_budget_is_refused(
    amount_limit: int, period_hours: int
) -> None:
    """The daily AI cap is gone, so nothing would count or enforce such a
    budget: the API refuses a new one, whatever its terms."""
    assert UsageMetric.HOSTED_AI_CALLS not in BUDGET_METRICS
    with pytest.raises(ValidationError, match="can't be set here"):
        BudgetCreateRequest(
            agent_id=None,
            metric="hosted_ai_calls",  # type: ignore[arg-type]
            model="",
            amount_limit=amount_limit,
            period_hours=period_hours,
        )


@pytest.mark.parametrize("metric", ["messages", "turns", "awake_minutes"])
def test_metrics_not_counted_per_model_name_no_model(metric: str) -> None:
    with pytest.raises(ValidationError, match="cannot name a model"):
        _request(metric, model="claude-x")


def test_token_budgets_can_still_name_a_model() -> None:
    assert _request("input_tokens", model="claude-x").model == "claude-x"
