"""data retention: a per-workspace message window, and a seq floor per room

``tenant_retention_policies`` holds at most one row per tenant: how many days
of room messages that workspace keeps. No row means messages are kept forever,
so nothing changes for existing tenants when this runs.

``rooms.seq_floor`` records the highest live ``seq`` retention has deleted
from a room, so numbering continues above it when a room's newest messages
are among those deleted. It starts at 0, which changes nothing for a room
retention has never touched.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: d8a4e2c61f07
Revises: a3d9f6c2b871
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8a4e2c61f07"
down_revision: str | None = "a3d9f6c2b871"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "tenant_retention_policies"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column(
            "seq_floor", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
    )
    op.create_table(
        "tenant_retention_policies",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("message_retention_days", sa.Integer(), nullable=False),
        sa.Column("updated_by_user_id", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_tenant_retention_policies_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "message_retention_days >= 1 AND message_retention_days <= 3650",
            name="ck_tenant_retention_policies_days",
        ),
        sa.PrimaryKeyConstraint("tenant_id"),
    )
    op.execute('ALTER TABLE "tenant_retention_policies" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "tenant_retention_policies"')
    op.drop_table("tenant_retention_policies")
    op.drop_column("rooms", "seq_floor")
