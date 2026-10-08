"""usage budgets: a ceiling on a metric over a repeating period

Revision ID: e3b7c9d2a415
Revises: c7e4a91d3b20

A budget caps one metric of ``tenant_usage`` for a whole tenant or for one
agent, optionally for one model, over a period of whole hours. An agent that
has reached a budget covering it is stopped until the period turns over. A
tenant with no budgets is unlimited, so nothing changes for existing tenants
when this runs.

Two partial unique indexes stand in for one unique constraint: ``agent_id`` is
null for a tenant-wide budget, and nulls never collide in a plain constraint.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3b7c9d2a415"
down_revision: str | Sequence[str] | None = "c7e4a91d3b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "usage_budgets"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)

_METRICS = (
    "messages",
    "turns",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
)


def upgrade() -> None:
    op.create_table(
        "usage_budgets",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("metric", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("amount_limit", sa.BigInteger(), nullable=False),
        sa.Column("period_hours", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_usage_budgets_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_usage_budgets_agent",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "metric IN ({})".format(", ".join(f"'{m}'" for m in _METRICS)),
            name="ck_usage_budgets_metric",
        ),
        sa.CheckConstraint(
            "amount_limit > 0 AND amount_limit <= 9007199254740991",
            name="ck_usage_budgets_amount_limit",
        ),
        sa.CheckConstraint(
            "period_hours > 0 AND period_hours <= 8784",
            name="ck_usage_budgets_period_hours",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_usage_budgets_tenant_wide",
        "usage_budgets",
        ["tenant_id", "metric", "model"],
        unique=True,
        postgresql_where=sa.text("agent_id IS NULL"),
    )
    op.create_index(
        "uq_usage_budgets_agent",
        "usage_budgets",
        ["tenant_id", "agent_id", "metric", "model"],
        unique=True,
        postgresql_where=sa.text("agent_id IS NOT NULL"),
    )
    op.execute('ALTER TABLE "usage_budgets" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "usage_budgets"')
    op.drop_index("uq_usage_budgets_agent", table_name="usage_budgets")
    op.drop_index("uq_usage_budgets_tenant_wide", table_name="usage_budgets")
    op.drop_table("usage_budgets")
