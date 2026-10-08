"""tenant_join_domains, and the lookup that finds the workspaces open to a domain

A workspace can let anyone signed in with an address at a domain join it
without an invitation. `tenant_join_domains` records those domains, one row per
tenant and domain. It is tenant-scoped like every other table and brings its
own `tenant_isolation` policy, for the reason `5daaea6b674d` gives.

Offering those workspaces to someone means reading the table across every
tenant before any is bound, so this also adds the eleventh lookup to the
exemption from row-level security: `tenants_open_to_domain` answers which
tenants are open to a domain, and the gateway then binds each and reads it
through the scoped store. See `db/tenant_lookup.py` for what it discloses and
why it is argued for.

The DDL below is a verbatim copy of `switch_core/db/rls_ddl.py` and
`switch_core/db/tenant_lookup.py` as they stood when this migration was
written, copied rather than imported so a later edit to either module cannot
change what this revision means.

Revision ID: 7d3f5a19e2c8
Revises: 4b8e2d61c9f7
Create Date: 2026-09-28 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7d3f5a19e2c8"
down_revision: str | None = "4b8e2d61c9f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "tenant_join_domains"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_OPEN_TO_DOMAIN = f"""CREATE OR REPLACE FUNCTION tenants_open_to_domain(p_domain text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM tenant_join_domains WHERE domain = lower(p_domain) ORDER BY tenant_id$$"""

DROP_TENANTS_OPEN_TO_DOMAIN = "DROP FUNCTION IF EXISTS tenants_open_to_domain(text)"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("domain", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "domain = lower(domain)", name="ck_tenant_join_domains_lower_case"
        ),
        sa.PrimaryKeyConstraint("tenant_id", "domain"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_tenant_join_domains_tenant"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)
    op.execute(CREATE_TENANTS_OPEN_TO_DOMAIN)


def downgrade() -> None:
    op.execute(DROP_TENANTS_OPEN_TO_DOMAIN)
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
