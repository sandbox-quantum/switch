"""the lookup that finds the organizations following WorkOS for a sign-in

Under the WorkOS directory a sign-in names the WorkOS organizations the
person belongs to, and which Switch organizations follow those, and which
ones following WorkOS the person is already in, has to be read before
anything is bound. This adds the sixteenth lookup to the exemption from
row-level security. See `db/tenant_lookup.py` for what it discloses.

The DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py` as it
stood when this migration was written, copied rather than imported so a later
edit cannot change what this revision means.

Revision ID: f2b8d6c1a4e9
Revises: 10f6d02ac5bc
Create Date: 2026-11-02 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "f2b8d6c1a4e9"
down_revision: str | Sequence[str] | None = "10f6d02ac5bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_DIRECTORY_ORGANIZATIONS_OF_USER = f"""CREATE OR REPLACE FUNCTION directory_organizations_of_user(p_user_id text, p_workos_organization_ids text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT id FROM organizations WHERE workos_organization_id IN (SELECT jsonb_array_elements_text(p_workos_organization_ids::jsonb)) OR (workos_organization_id IS NOT NULL AND id IN (SELECT organization_id FROM organization_members WHERE user_id = p_user_id)) ORDER BY id$$"""

DROP_DIRECTORY_ORGANIZATIONS_OF_USER = (
    "DROP FUNCTION IF EXISTS directory_organizations_of_user(text, text)"
)


def upgrade() -> None:
    op.execute(CREATE_DIRECTORY_ORGANIZATIONS_OF_USER)


def downgrade() -> None:
    op.execute(DROP_DIRECTORY_ORGANIZATIONS_OF_USER)
