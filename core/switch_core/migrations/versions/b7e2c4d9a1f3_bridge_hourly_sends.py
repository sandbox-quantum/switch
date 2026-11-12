"""bridge hourly sends: a per-recipient hourly send count every process shares

``bridge_hourly_sends`` holds what a bridge has sent one recipient in one clock
hour, and whether the recipient has been told the limit is reached. The SMS
bridge kept both in each process's memory, so with several processes a number
could be sent the limit once per process and told once per process.

Expand only: a release from before this revision never reads the table.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: b7e2c4d9a1f3
Revises: 7105e0bea527
Create Date: 2026-11-06 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7e2c4d9a1f3"
down_revision: str | None = "7105e0bea527"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def upgrade() -> None:
    op.create_table(
        "bridge_hourly_sends",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("recipient", sa.Text(), nullable=False),
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
        sa.Column("units", sa.Integer(), nullable=False),
        sa.Column(
            "told_limit", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_bridge_hourly_sends_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_bridge_hourly_sends_bridge",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("tenant_id", "bridge_id", "recipient", "hour"),
    )
    op.execute('ALTER TABLE "bridge_hourly_sends" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY {POLICY_NAME} ON "bridge_hourly_sends"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "bridge_hourly_sends"')
    op.drop_table("bridge_hourly_sends")
