"""template run records: how many times each template has been run

``template_run_records`` holds one row for each run of a template in a
workspace, by the template's id (an ``official:`` id or a stored template's),
so the catalogue can say how often each one is used. It records nothing about
who ran it.

Expand only: a release from before this revision never reads the table.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: d41f9a7c2e58
Revises: c8e2f4a6b1d3
Create Date: 2026-11-12 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d41f9a7c2e58"
down_revision: str | None = "c8e2f4a6b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def upgrade() -> None:
    op.create_table(
        "template_run_records",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("template_id", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_template_run_records_tenant"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_template_run_records_tenant_template",
        "template_run_records",
        ["tenant_id", "template_id"],
    )
    op.execute('ALTER TABLE "template_run_records" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy("template_run_records"))


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "template_run_records"')
    op.drop_index(
        "ix_template_run_records_tenant_template", table_name="template_run_records"
    )
    op.drop_table("template_run_records")
