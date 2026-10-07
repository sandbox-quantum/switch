"""tenant data moves: which one-time data moves each tenant has had

One row per tenant and move, written in the move's own transaction, so a move
runs once per tenant. The first is GitHub's, from `provider_connections` and
`github_issued_tokens` to the service connection tables, carried out at boot
by `switch_core/connections/github_move.py` because it needs the server's keys.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Revision ID: 5e04ecff65b8
Revises: 4a64c0cbcd9a
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5e04ecff65b8"
down_revision: str | Sequence[str] | None = "4a64c0cbcd9a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
TABLE = "tenant_data_moves"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("details", postgresql.JSONB(), nullable=False),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "name"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_tenant_data_moves_tenant"
        ),
    )
    op.execute(f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY {POLICY_NAME} ON "{TABLE}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"')
    op.drop_table(TABLE)
