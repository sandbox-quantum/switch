"""hosted usage metrics: awake minutes and hosted AI calls

Two more values for what `tenant_usage` counts, and one of them for what a
budget may cap. No new table and no new column:

- `awake_minutes`: minutes each hosted agent was awake, counted per agent
  under its own `client_id` from its controller's status reports. A budget may
  cap it, and `BudgetGuard` then refuses the agent's next work.
- `hosted_ai_calls`: AI calls through a hosted box's credential gateway, as the
  day's rise in the count the box reports. `usage_budgets` accepts it too (the
  lead), so the later cap-from-budget set needs no migration of its own: such a
  budget is the hosted daily cap, enforced by the gateway. `BudgetGuard` never
  enforces it, because the count comes from the box.

The downgrade refuses while any row uses a new value, rather than deleting
counted usage or a budget someone set.

Revision ID: eb7e622cf3b0
Revises: d3a7f1c2b8e4
Create Date: 2026-10-29 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "eb7e622cf3b0"
down_revision: str | Sequence[str] | None = "d3a7f1c2b8e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
# Additive: it only widens two checks. An older Core reads `metric` as plain
# text, so it runs on this schema. The one catch, an older `BudgetGuard`
# enforcing a `hosted_ai_calls` budget, is the daily cap's to handle, since only
# the daily cap lets such a budget exist.
expand_only: bool = True

_OLD = (
    "messages",
    "turns",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
)
_USAGE_NEW = (*_OLD, "awake_minutes", "hosted_ai_calls")
_BUDGET_NEW = _USAGE_NEW


def _check(values: Sequence[str]) -> str:
    return "metric IN ({})".format(", ".join(f"'{v}'" for v in values))


def _replace(table: str, name: str, values: Sequence[str]) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, _check(values))


def upgrade() -> None:
    _replace("tenant_usage", "ck_tenant_usage_metric", _USAGE_NEW)
    _replace("usage_budgets", "ck_usage_budgets_metric", _BUDGET_NEW)


def downgrade() -> None:
    bind = op.get_bind()
    for table in ("tenant_usage", "usage_budgets"):
        in_use = bind.execute(
            text(
                f"SELECT count(*) FROM {table} "  # noqa: S608 - fixed table names
                "WHERE metric IN ('awake_minutes', 'hosted_ai_calls')"
            )
        ).scalar_one()
        if in_use:
            raise RuntimeError(
                f"{table} has {in_use} row(s) using a hosted usage metric; "
                "remove them deliberately before downgrading"
            )
    _replace("usage_budgets", "ck_usage_budgets_metric", _OLD)
    _replace("tenant_usage", "ck_tenant_usage_metric", _OLD)
