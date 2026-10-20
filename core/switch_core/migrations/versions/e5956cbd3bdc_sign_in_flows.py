"""sign_in_flows: a sign-in under way, readable by every switch-core process

A person connecting GitHub or a catalog service from Switch Console makes
half a dozen requests, from Console and from their browser. Until now the
flow they belonged to lived in the memory of the process that started it, so
with several processes behind one address any step that reached another
process found nothing and was told the sign-in had been interrupted. The flow
moves here, scoped to its tenant like every other per-workspace row, and
`tenant_of_sign_in_flow` names that tenant for the browser's steps, which
carry only the flow's state.

Expand only: a process from before this revision keeps its flows in memory
and never reads this table.

The lookup's DDL is a frozen copy of `switch_core/db/tenant_lookup.py`'s, as
every revision in this chain copies rather than imports.

Revision ID: e5956cbd3bdc
Revises: e2b0df5be5ff
Create Date: 2026-10-14 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "e5956cbd3bdc"
down_revision: str | None = "e2b0df5be5ff"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_SIGN_IN_FLOW = f"""CREATE OR REPLACE FUNCTION tenant_of_sign_in_flow(p_state text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM sign_in_flows WHERE id = p_state AND expires_at > now()$$"""

DROP_TENANT_OF_SIGN_IN_FLOW = "DROP FUNCTION IF EXISTS tenant_of_sign_in_flow(text)"


def upgrade() -> None:
    op.create_table(
        "sign_in_flows",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_sign_in_flows_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("mode", sa.Text(), nullable=False),
        sa.Column("port", sa.Integer(), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("owner_label", sa.Text(), nullable=False),
        sa.Column("details", JSONB(), nullable=False),
        sa.Column("encrypted_verifier", sa.Text(), nullable=False),
        sa.Column("completion_secret_hash", sa.Text(), nullable=False),
        sa.Column("browser_nonce_hash", sa.Text(), nullable=True),
        sa.Column("encrypted_result", sa.Text(), nullable=True),
        sa.Column("account_label", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "kind IN ('github', 'service')", name="ck_sign_in_flows_kind"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'authorizing', 'returning', 'delivered', "
            "'checking', 'ready', 'failed')",
            name="ck_sign_in_flows_status",
        ),
        sa.CheckConstraint(
            "mode IN ('loopback', 'core')", name="ck_sign_in_flows_mode"
        ),
    )
    op.create_index(
        "ix_sign_in_flows_user", "sign_in_flows", ["tenant_id", "user_id", "kind"]
    )
    op.execute("ALTER TABLE sign_in_flows ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON sign_in_flows FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )
    op.execute(CREATE_TENANT_OF_SIGN_IN_FLOW)


def downgrade() -> None:
    op.execute(DROP_TENANT_OF_SIGN_IN_FLOW)
    op.drop_table("sign_in_flows")
