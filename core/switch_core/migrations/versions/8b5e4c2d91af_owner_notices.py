"""Durable owner notices for unverified agent invitations.

Revision ID: 8b5e4c2d91af
Revises: f3a8d1c6b927
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8b5e4c2d91af"
down_revision: str | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "owner_notices",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "kind = 'unverified_agent_invite'", name="ck_owner_notices_kind"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_owner_notices_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["agent_id", "tenant_id"],
            ["agents.id", "agents.tenant_id"],
            name="fk_owner_notices_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["room_id", "tenant_id"],
            ["rooms.id", "rooms.tenant_id"],
            name="fk_owner_notices_room",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "tenant_id", "agent_id", "room_id", name="uq_owner_notices_pending_join"
        ),
    )
    op.create_index(
        "ix_owner_notices_tenant_created", "owner_notices", ["tenant_id", "created_at"]
    )
    op.execute('ALTER TABLE "owner_notices" ENABLE ROW LEVEL SECURITY')
    op.execute(
        'CREATE POLICY tenant_isolation ON "owner_notices" FOR ALL USING ("tenant_id" = (SELECT require_tenant_id())) WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))'
    )


def downgrade() -> None:
    op.drop_index("ix_owner_notices_tenant_created", table_name="owner_notices")
    op.drop_table("owner_notices")
