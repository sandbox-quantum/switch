"""archived workspaces: `tenants.archived_at` and who may still enter one

An organization's admins may now archive one of its workspaces: it is kept,
whole, but closed. `archived_at` says since when, and `archived_by` who did
it, cleared when that account is deleted.

`tenants_bindable_by_user` is redefined so a membership in an archived
workspace no longer makes it one its member may enter. The organization's
`org_admin`s still may, as the half of the function that reaches them is left
as it was. That is the one place the closing has to happen for every request,
since it is read once per request already; everything else an archived
workspace refuses is in Python (`workspace_archive.py`).

The lookup DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py`
as it stood when this migration was written, copied rather than imported for
the reason every revision in this chain copies. The restore is the body
`5c2e8f17a9d4` installed.

Expand only: a release from before this revision reads neither column, and
the narrower function only keeps it from binding a workspace this one has
closed.

Revision ID: e2c7a94f1b38
Revises: b7d24e9c1f53
Create Date: 2026-11-12 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e2c7a94f1b38"
down_revision: str | None = "b7d24e9c1f53"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_BINDABLE_BY_USER = f"""CREATE OR REPLACE FUNCTION tenants_bindable_by_user(p_user_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_members.tenant_id FROM tenant_members JOIN tenants ON tenants.id = tenant_members.tenant_id WHERE tenant_members.user_id = p_user_id AND tenants.archived_at IS NULL UNION SELECT tenants.id FROM tenants JOIN organization_members ON organization_members.organization_id = tenants.organization_id WHERE organization_members.user_id = p_user_id AND organization_members.role = 'org_admin' ORDER BY 1$$"""

RESTORE_TENANTS_BINDABLE_BY_USER = f"""CREATE OR REPLACE FUNCTION tenants_bindable_by_user(p_user_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM tenant_members WHERE user_id = p_user_id UNION SELECT tenants.id FROM tenants JOIN organization_members ON organization_members.organization_id = tenants.organization_id WHERE organization_members.user_id = p_user_id AND organization_members.role = 'org_admin' ORDER BY 1$$"""


def upgrade() -> None:
    op.add_column(
        "tenants", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("tenants", sa.Column("archived_by", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_tenants_archived_by",
        "tenants",
        "users",
        ["archived_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(CREATE_TENANTS_BINDABLE_BY_USER)


def downgrade() -> None:
    op.execute(RESTORE_TENANTS_BINDABLE_BY_USER)
    op.drop_constraint("fk_tenants_archived_by", "tenants", type_="foreignkey")
    op.drop_column("tenants", "archived_by")
    op.drop_column("tenants", "archived_at")
