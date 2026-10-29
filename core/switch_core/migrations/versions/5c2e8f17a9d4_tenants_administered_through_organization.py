"""the lookup that finds the workspaces a person administers through an organization

An organization's `org_admin` administers every workspace in it and may bind
one without a membership row there. Resolving which workspaces those are
happens before any is bound, so this adds the fourteenth lookup to the
exemption from row-level security. See `db/tenant_lookup.py` for what it
discloses.

The DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py` as it
stood when this migration was written, copied rather than imported so a later
edit cannot change what this revision means.

Revision ID: 5c2e8f17a9d4
Revises: 238c68b7306e
Create Date: 2026-10-29 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "5c2e8f17a9d4"
down_revision: str | Sequence[str] | None = "238c68b7306e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_ADMINISTERED_THROUGH_ORGANIZATION = f"""CREATE OR REPLACE FUNCTION tenants_administered_through_organization(p_user_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenants.id FROM tenants JOIN organization_members ON organization_members.organization_id = tenants.organization_id WHERE organization_members.user_id = p_user_id AND organization_members.role = 'org_admin' ORDER BY tenants.id$$"""

DROP_TENANTS_ADMINISTERED_THROUGH_ORGANIZATION = (
    "DROP FUNCTION IF EXISTS tenants_administered_through_organization(text)"
)


def upgrade() -> None:
    op.execute(CREATE_TENANTS_ADMINISTERED_THROUGH_ORGANIZATION)


def downgrade() -> None:
    op.execute(DROP_TENANTS_ADMINISTERED_THROUGH_ORGANIZATION)
