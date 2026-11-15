"""the directory mirror: its event cursor and the lookup it reads

`directory_event_cursors` records how far the mirror has read a directory's
events, one row per directory. A global table: no tenant column and no
row-level security policy (`db/rls_ddl.py`'s `GLOBAL_TABLES`).

`directory_organizations` is the seventeenth lookup in the exemption from
row-level security: every organization that follows one in the directory.
See `db/tenant_lookup.py` for what it discloses. Its DDL is a verbatim copy
of `switch_core/db/tenant_lookup.py` as it stood when this migration was
written, copied rather than imported so a later edit cannot change what this
revision means.

Revision ID: a7c3e9f15b20
Revises: f2b8d6c1a4e9
Create Date: 2026-11-02 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c3e9f15b20"
down_revision: str | Sequence[str] | None = "f2b8d6c1a4e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_DIRECTORY_ORGANIZATIONS = f"""CREATE OR REPLACE FUNCTION directory_organizations()
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT id FROM organizations WHERE workos_organization_id IS NOT NULL ORDER BY id$$"""

DROP_DIRECTORY_ORGANIZATIONS = "DROP FUNCTION IF EXISTS directory_organizations()"


def upgrade() -> None:
    op.create_table(
        "directory_event_cursors",
        sa.Column("source", sa.Text(), primary_key=True),
        sa.Column("after", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.execute(CREATE_DIRECTORY_ORGANIZATIONS)


def downgrade() -> None:
    op.execute(DROP_DIRECTORY_ORGANIZATIONS)
    op.drop_table("directory_event_cursors")
