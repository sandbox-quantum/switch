"""invitations, and the lookup that resolves one to a tenant

A credential that grants membership in a tenant (CHOO-2722,
`docs/old/multi-tenancy-phase2-tenants.md` §5). It is tenant-scoped like
everything else, so it gets the same `tenant_isolation` policy as the other
tables — written out below rather than inherited, because `265ed188ad6f`
installed the policies as they stood then and a table added afterwards has to
bring its own.

`token_hash` is unique across the deployment rather than per tenant, for the
same reason `api_keys.key_hash` is: accepting an invitation resolves the hash
before a tenant is known, so a per-tenant index could not answer the question
being asked. Only the hash is ever stored — the token itself never reaches
this table, or any other.

`tenant_of_invitation(token_hash)` is the lookup that resolves it, and it is
an addition to the closed set of `SECURITY DEFINER` functions `9c41a7b0e5d8`
installed as the whole exemption from row-level security. That set is
deliberately short and every entry in it is callable by anyone holding the
runtime role's credentials, so adding one is meant to be argued with. The
argument for this one: accepting an invitation is exactly the credential-
resolution shape the rest of the module is built on — a token and nothing
else, no tenant bound yet — and without it there is no way to bind a tenant
before reading the row the token names.

The DDL below is a verbatim copy of `switch_core/db/rls_ddl.py` and
`switch_core/db/tenant_lookup.py` as they stood when this migration was
written, copied rather than imported for the same reason every other revision
in this chain copies rather than imports: a migration is a record of a change
that already happened, and importing the live module would let a later edit
silently change what this one means.
`tests/switch_core/db/test_frozen_ddl_matches_create_all.py` is what keeps the
copy from drifting.

Revision ID: 5daaea6b674d
Revises: 8ef6d4038ecc
Create Date: 2026-09-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5daaea6b674d"
down_revision: str | None = "8ef6d4038ecc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "invitations"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_INVITATION = f"""CREATE OR REPLACE FUNCTION tenant_of_invitation(p_token_hash text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM invitations WHERE token_hash = p_token_hash$$"""

DROP_TENANT_OF_INVITATION = "DROP FUNCTION IF EXISTS tenant_of_invitation(text)"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("uses_remaining", sa.Integer(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member')", name="ck_invitations_role"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_invitations_tenant"
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.UniqueConstraint("token_hash"),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)
    op.execute(CREATE_TENANT_OF_INVITATION)


def downgrade() -> None:
    op.execute(DROP_TENANT_OF_INVITATION)
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
