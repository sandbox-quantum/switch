"""trust agent inventory: where it was sent, and whether it shares instructions

`organization_trust_settings.share_agent_instructions` says whether the agent
inventory sent to the organization's Switch Trust carries each managed
agent's instructions. Off by default: an agent's instructions are its
organization's to share, and one that connected a policy before the
inventory existed agreed to message checks, not to sending its prompts.

`trust_inventory_targets` holds each Switch Trust (endpoint and API key) the
agent inventory has been sent to, so the agents can be withdrawn from one no
organization's settings name any more. `trust_inventory_sent` holds, per
target and workspace, the snapshot last taken and any failure being held off,
so a restart, a change of the process running the sync, or a deleted
workspace loses none of it.

Expand only: a release from before this revision never reads the column or
the tables, and never sends an inventory.

Revision ID: 8c41e7a2d5f3
Revises: c18f5ebeef66
Create Date: 2026-11-23 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8c41e7a2d5f3"
down_revision: str | None = "c18f5ebeef66"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "organization_trust_settings",
        sa.Column(
            "share_agent_instructions",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.create_table(
        "trust_inventory_targets",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "trust_inventory_sent",
        sa.Column("target_id", sa.Text(), nullable=False),
        sa.Column("tenant", sa.Text(), nullable=False),
        sa.Column("digest", sa.Text(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed_digest", sa.Text(), nullable=True),
        sa.Column("failures", sa.Integer(), server_default="0", nullable=False),
        sa.Column("retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["target_id"],
            ["trust_inventory_targets.id"],
            name="fk_trust_inventory_sent_target",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("target_id", "tenant"),
    )


def downgrade() -> None:
    op.drop_table("trust_inventory_sent")
    op.drop_table("trust_inventory_targets")
    op.drop_column("organization_trust_settings", "share_agent_instructions")
