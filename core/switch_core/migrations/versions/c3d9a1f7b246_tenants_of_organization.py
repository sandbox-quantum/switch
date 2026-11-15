"""the lookup that lists one organization's workspaces

The platform operator may bind any workspace and holds no membership to
narrow by, so listing an organization's workspaces for them meant binding
every tenant in turn. This adds the eighteenth lookup to the exemption from
row-level security, `tenants_of_organization`. See `db/tenant_lookup.py` for
what it discloses.

The DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py` as it
stood when this migration was written, copied rather than imported so a later
edit cannot change what this revision means.

Revision ID: c3d9a1f7b246
Revises: a7c3e9f15b20
Create Date: 2026-11-05 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c3d9a1f7b246"
down_revision: str | Sequence[str] | None = "a7c3e9f15b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_OF_ORGANIZATION = f"""CREATE OR REPLACE FUNCTION tenants_of_organization(p_organization_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT id FROM tenants WHERE organization_id = p_organization_id ORDER BY id$$"""

DROP_TENANTS_OF_ORGANIZATION = "DROP FUNCTION IF EXISTS tenants_of_organization(text)"


def upgrade() -> None:
    op.execute(CREATE_TENANTS_OF_ORGANIZATION)


def downgrade() -> None:
    op.execute(DROP_TENANTS_OF_ORGANIZATION)
