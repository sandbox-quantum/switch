"""add tenant_id to templates and enable row-level security

The templates table was created before the RLS wave and has no tenant_id
column and no RLS policy. This migration adds both, using the same pattern
as every other tenant-scoped table (8b276792ee30 + 265ed188ad6f).

Existing rows are backfilled with tenant zero. The old per-owner unique
constraint is replaced with one that includes tenant_id so the same name
can exist under different tenants.

Revision ID: e0e1d6e054cc
Revises: a3f61c02d5be, b1d7c4f0a92e
Create Date: 2026-09-11 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e0e1d6e054cc"
down_revision: str | Sequence[str] | None = ("a3f61c02d5be", "b1d7c4f0a92e")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_ZERO = "00000000-0000-0000-0000-000000000000"

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"


def upgrade() -> None:
    # 1. Add tenant_id column (nullable first for backfill)
    op.add_column(
        "templates",
        sa.Column("tenant_id", sa.Text(), nullable=True),
    )

    # 2. Backfill existing rows with tenant zero
    op.execute(
        sa.text(
            f"UPDATE templates SET tenant_id = '{TENANT_ZERO}' WHERE tenant_id IS NULL"
        )
    )

    # 3. Make non-nullable and add FK
    op.alter_column("templates", "tenant_id", nullable=False)
    op.create_foreign_key(
        "fk_templates_tenant", "templates", "tenants", ["tenant_id"], ["id"]
    )

    # 4. Replace the unique constraint: (owner_id, name) → (tenant_id, owner_id, name)
    op.drop_constraint("uq_templates_owner_name", "templates", type_="unique")
    op.create_unique_constraint(
        "uq_templates_tenant_owner_name", "templates", ["tenant_id", "owner_id", "name"]
    )

    # 5. Enable RLS and create the policy — same pattern as 265ed188ad6f
    predicate = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
    op.execute(sa.text('ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY'))
    op.execute(
        sa.text(
            f'CREATE POLICY {POLICY_NAME} ON "templates"\n'
            f"    FOR ALL\n"
            f"    USING ({predicate})\n"
            f"    WITH CHECK ({predicate})"
        )
    )


def downgrade() -> None:
    op.execute(sa.text(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "templates"'))
    op.execute(sa.text('ALTER TABLE "templates" DISABLE ROW LEVEL SECURITY'))
    op.drop_constraint("uq_templates_tenant_owner_name", "templates", type_="unique")
    op.create_unique_constraint(
        "uq_templates_owner_name", "templates", ["owner_id", "name"]
    )
    op.drop_constraint("fk_templates_tenant", "templates", type_="foreignkey")
    op.drop_column("templates", "tenant_id")
