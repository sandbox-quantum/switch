"""the lookup that finds a customer's organization

Under the WorkOS directory a sign-in names the customers the person belongs
to by the customer's id, and which Switch organization each one is has to be
read before anything is bound. This adds the fifteenth lookup to the
exemption from row-level security. See `db/tenant_lookup.py` for what it
discloses.

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

CREATE_ORGANIZATION_OF_CUSTOMER = f"""CREATE OR REPLACE FUNCTION organization_of_customer(p_customer_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT id FROM organizations WHERE customer_id = p_customer_id$$"""

DROP_ORGANIZATION_OF_CUSTOMER = "DROP FUNCTION IF EXISTS organization_of_customer(text)"


def upgrade() -> None:
    op.execute(CREATE_ORGANIZATION_OF_CUSTOMER)


def downgrade() -> None:
    op.execute(DROP_ORGANIZATION_OF_CUSTOMER)
