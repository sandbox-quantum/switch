"""record which agent created a room, and how deep in a chain of agent-created rooms it is

Revision ID: a3c9e1f7b2d4
Revises: b8f2d0c41e57
Create Date: 2026-09-17 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3c9e1f7b2d4"
down_revision: str | None = "b8f2d0c41e57"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("created_by_agent_id", sa.Text(), nullable=True),
    )
    # Carries tenant_id like every foreign key between tenant-scoped tables.
    # Only the agent column is cleared when the agent goes; tenant_id stays.
    op.create_foreign_key(
        "fk_rooms_created_by_agent",
        "rooms",
        "agents",
        ["tenant_id", "created_by_agent_id"],
        ["tenant_id", "id"],
        ondelete="SET NULL (created_by_agent_id)",
    )
    op.add_column(
        "rooms",
        sa.Column(
            "agent_creation_depth",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    # The hourly cap counts an agent's recent rooms on every create.
    op.create_index(
        "ix_rooms_created_by_agent_id_created_at",
        "rooms",
        ["created_by_agent_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_rooms_created_by_agent_id_created_at", table_name="rooms")
    op.drop_column("rooms", "agent_creation_depth")
    op.drop_constraint("fk_rooms_created_by_agent", "rooms", type_="foreignkey")
    op.drop_column("rooms", "created_by_agent_id")
