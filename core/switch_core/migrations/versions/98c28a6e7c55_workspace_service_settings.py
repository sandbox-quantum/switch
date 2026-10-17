"""workspace service settings: an admin's switch per service, per workspace

One tenant-scoped table, `workspace_service_settings`, keyed by tenant and
catalog slug, holding whether a workspace admin switched the service on or off.
No row means on, so an upgraded server behaves as before with the table empty:
there is no data step.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Expand only: a process from before this revision never reads the table, and
reads every service as on, as it always did.

Revision ID: 98c28a6e7c55
Revises: 5f97c7c7407a
Create Date: 2026-10-14 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "98c28a6e7c55"
down_revision: str | Sequence[str] | None = "5f97c7c7407a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
TABLE = "workspace_service_settings"

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
        TABLE,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "service"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_workspace_service_settings_tenant"
        ),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
    )
    op.execute(f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(TABLE))


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"')
    op.drop_table(TABLE)
