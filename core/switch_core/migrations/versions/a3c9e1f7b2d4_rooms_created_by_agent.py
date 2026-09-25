"""record which agent created a room and where it sits in its run

Revision ID: a3c9e1f7b2d4
Revises: e3b7c9d2a415
Create Date: 2026-09-17 00:00:00.000000

A room an agent creates records the agent, the room it was working in when
it asked (``parent_room_id``) and the root of the chain (``run_id``), a room
a person made. Together they give each run as a tree, which is what lets a
person see how a template ran and stop it. ``template_name`` and
``kickoff_hash`` say what the room was for, closely enough to tell a new step
from the same request made again. ``run_control`` is set on a run's root when
the run is paused or stopped.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a3c9e1f7b2d4"
down_revision: str | None = "e3b7c9d2a415"
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
    op.add_column("rooms", sa.Column("parent_room_id", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_rooms_parent_room",
        "rooms",
        "rooms",
        ["tenant_id", "parent_room_id"],
        ["tenant_id", "id"],
        ondelete="SET NULL (parent_room_id)",
    )
    op.add_column("rooms", sa.Column("run_id", sa.Text(), nullable=True))
    op.add_column("rooms", sa.Column("template_name", sa.Text(), nullable=True))
    op.add_column("rooms", sa.Column("kickoff_hash", sa.Text(), nullable=True))
    op.add_column("rooms", sa.Column("run_control", JSONB(), nullable=True))
    # A run is listed, checked and stopped by its root on every agent create
    # and every look at Recently used.
    op.create_index("ix_rooms_run_id", "rooms", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_rooms_run_id", table_name="rooms")
    op.drop_column("rooms", "run_control")
    op.drop_column("rooms", "kickoff_hash")
    op.drop_column("rooms", "template_name")
    op.drop_column("rooms", "run_id")
    op.drop_constraint("fk_rooms_parent_room", "rooms", type_="foreignkey")
    op.drop_column("rooms", "parent_room_id")
    op.drop_constraint("fk_rooms_created_by_agent", "rooms", type_="foreignkey")
    op.drop_column("rooms", "created_by_agent_id")
