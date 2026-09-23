"""per-tenant usage, counted as it happens

Revision ID: c7e4a91d3b20
Revises: c4e9a1f7b203

The metering record quotas are enforced against and billing will read: one row
per tenant, metric, hour, consumer and model, incremented in the same
transaction as the message or turn it counts (CHOO-2625).

It is a table of its own rather than a count over ``messages`` because usage
must outlive what it counts: deleting a room cascades to its messages, and a
tenant's spend cannot shrink when it tidies up. Nothing here can be backfilled
— counting starts when this migration runs.

Buckets are an hour wide so that a budget period can be any whole number of
hours; the key leads on the metric so the question a budget asks, "this
tenant's turns since a moment", is a range scan on the key itself.

``client_id`` carries no foreign key, so a count outlives the client it names.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e4a91d3b20"
down_revision: str | Sequence[str] | None = "c4e9a1f7b203"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "tenant_usage"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


def upgrade() -> None:
    op.create_table(
        "tenant_usage",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("metric", sa.Text(), nullable=False),
        sa.Column("bucket_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_tenant_usage_tenant"
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id", "metric", "bucket_start", "client_id", "model"
        ),
        sa.CheckConstraint(
            "metric IN ('messages', 'turns', 'input_tokens', 'output_tokens')",
            name="ck_tenant_usage_metric",
        ),
        sa.CheckConstraint("amount > 0", name="ck_tenant_usage_amount"),
    )
    op.execute('ALTER TABLE "tenant_usage" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "tenant_usage"')
    op.drop_table("tenant_usage")
