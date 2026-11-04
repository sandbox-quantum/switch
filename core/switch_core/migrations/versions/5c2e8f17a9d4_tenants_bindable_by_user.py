"""the lookup that finds the workspaces a person may enter, through an organization too

An organization's `org_admin` administers every workspace in it and may bind
one without a membership row there. Resolving which workspaces a person may
bind happens before any is bound, on every authenticated request, so this
adds the fourteenth lookup to the exemption from row-level security: one
function answering both halves, membership rows and `org_admin`, so a request
pays one lookup rather than two. See `db/tenant_lookup.py` for what it
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

CREATE_TENANTS_BINDABLE_BY_USER = f"""CREATE OR REPLACE FUNCTION tenants_bindable_by_user(p_user_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM tenant_members WHERE user_id = p_user_id UNION SELECT tenants.id FROM tenants JOIN organization_members ON organization_members.organization_id = tenants.organization_id WHERE organization_members.user_id = p_user_id AND organization_members.role = 'org_admin' ORDER BY 1$$"""

DROP_TENANTS_BINDABLE_BY_USER = "DROP FUNCTION IF EXISTS tenants_bindable_by_user(text)"


def upgrade() -> None:
    op.execute(CREATE_TENANTS_BINDABLE_BY_USER)


def downgrade() -> None:
    op.execute(DROP_TENANTS_BINDABLE_BY_USER)
