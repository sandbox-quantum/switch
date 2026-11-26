"""hidden_official_templates: official templates a workspace admin removed

The templates that come with Switch are served from the package, not stored,
so removing one from a workspace is recorded here: one row per workspace and
template slug, naming the admin who removed it. The table starts empty; every
workspace keeps every official template until an admin removes one.

The `tenant_isolation` policy is written out below rather than inherited,
because `265ed188ad6f` installed the policies as they stood then and a table
added afterwards has to bring its own. The DDL is a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written.

Expand only: a release from before this revision never reads the new table.

Revision ID: d3a8f1c62b07
Revises: d41f9a7c2e58
Create Date: 2026-11-11 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3a8f1c62b07"
down_revision: str | None = "d41f9a7c2e58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "hidden_official_templates"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("hidden_by", sa.Text(), nullable=True),
        sa.Column(
            "hidden_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "slug"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_hidden_official_templates_tenant"
        ),
        sa.ForeignKeyConstraint(["hidden_by"], ["users.id"], ondelete="SET NULL"),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
