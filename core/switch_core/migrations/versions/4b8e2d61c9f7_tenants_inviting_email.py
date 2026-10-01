"""tenants_inviting_email: which workspaces have invited an address

A person signed in to Switch can be shown the invitations addressed to them
and accept one without the link. Listing those means reading `invitations`
across every tenant that might hold one, before any of them is bound — the
read row-level security refuses to a session with nothing bound. This adds the
tenth lookup to the exemption: it answers which tenants hold a live
invitation addressed to an e-mail, and the gateway then binds each tenant and
reads its invitations through the scoped store. See `db/tenant_lookup.py` for
what the exemption discloses and why this one is argued for.

The lookup DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py`
as it stood when this migration was written, copied rather than imported so a
later edit to the module cannot change what this revision means.
`tests/switch_core/db/test_tenant_lookup.py` keeps the copy honest.

Revision ID: 4b8e2d61c9f7
Revises: 60b934c4c034
Create Date: 2026-09-28 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "4b8e2d61c9f7"
down_revision: str | None = "60b934c4c034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_INVITING_EMAIL = f"""CREATE OR REPLACE FUNCTION tenants_inviting_email(p_email text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT DISTINCT tenant_id FROM invitations WHERE lower(email) = lower(p_email) AND revoked_at IS NULL AND expires_at > now() AND uses_remaining > 0 ORDER BY tenant_id$$"""

DROP_TENANTS_INVITING_EMAIL = "DROP FUNCTION IF EXISTS tenants_inviting_email(text)"


def upgrade() -> None:
    op.execute(CREATE_TENANTS_INVITING_EMAIL)


def downgrade() -> None:
    op.execute(DROP_TENANTS_INVITING_EMAIL)
