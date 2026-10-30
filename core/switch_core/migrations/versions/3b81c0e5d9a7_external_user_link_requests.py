"""external user link requests, and when a claim was verified

A link from a chat account to a Switch user now waits in
`external_user_link_requests` until the account confirms it by posting a
one-time code, and only then becomes a row in `external_user_claims`.

The requests get a table of their own rather than a state on the claims,
because every reader of `external_user_claims` treats a row as trusted. A
pending row there would be trusted by any reader that forgot to filter it out,
and by every reader in a release from before this revision while the two run
side by side.

`external_user_claims.verified_at` says when the account confirmed a claim. It
is null for every claim that exists before this revision: those keep working,
and Console asks their owners to confirm them.

The `tenant_isolation` policy is written out below rather than inherited,
because `265ed188ad6f` installed the policies as they stood then and a table
added afterwards has to bring its own. The DDL is a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written,
copied rather than imported so a later edit to that module cannot change what
this revision means. `tests/switch_core/db/test_frozen_ddl_matches_create_all.py`
keeps the copy from drifting.

Expand only: a release from before this revision never reads the new table or
column, and its claims are written straight into `external_user_claims` as
they always were, where they read as unverified.

Revision ID: 3b81c0e5d9a7
Revises: b7e1d4c9a2f6
Create Date: 2026-10-27 19:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3b81c0e5d9a7"
down_revision: str | None = "b7e1d4c9a2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "external_user_link_requests"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'


def upgrade() -> None:
    op.add_column(
        "external_user_claims",
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_table(
        TABLE,
        sa.Column("external_user_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("requested_by_user_id", sa.Text(), nullable=True),
        sa.Column("code_hash", sa.Text(), nullable=True),
        sa.Column("code_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("external_user_id", "user_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_external_user_link_requests_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "external_user_id"],
            ["external_users.tenant_id", "external_users.id"],
            name="fk_external_user_link_requests_external_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_external_user_link_requests_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"],
            ["users.id"],
            name="fk_external_user_link_requests_requested_by",
            ondelete="SET NULL",
        ),
    )
    op.create_index("ix_external_user_link_requests_tenant_id", TABLE, ["tenant_id"])
    op.create_index("ix_external_user_link_requests_user_id", TABLE, ["user_id"])
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_index("ix_external_user_link_requests_user_id", table_name=TABLE)
    op.drop_index("ix_external_user_link_requests_tenant_id", table_name=TABLE)
    op.drop_table(TABLE)
    op.drop_column("external_user_claims", "verified_at")
