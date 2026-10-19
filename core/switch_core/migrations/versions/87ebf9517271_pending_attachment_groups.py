"""pending_attachment_groups: multi-file posts the router has not decided yet

The router decides, as a room row is written, which agents it is for, and
stores their own events in the same transaction. A post of several files is
written as one row per file and can only be decided once its files are rows,
so a file that does not complete its post records the post here. The file
that completes it deletes the row and stores the post's own events; a post
whose files stop arriving is decided by a sweep every process runs once
`deadline` has passed, claiming the row with `FOR UPDATE SKIP LOCKED`.

Expand only: a process from before this revision assembles posts in its agent
consumers' memory and never reads this table.

Revision ID: 87ebf9517271
Revises: c8f2a6d4e1b9
Create Date: 2026-10-14 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "87ebf9517271"
down_revision: str | None = "c8f2a6d4e1b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "pending_attachment_groups",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_pending_attachment_groups_tenant"),
            nullable=False,
        ),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("group_id", sa.Text(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("from_seq", sa.BigInteger(), nullable=False),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("room_id", "group_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_pending_attachment_groups_room",
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_pending_attachment_groups_deadline",
        "pending_attachment_groups",
        ["tenant_id", "deadline"],
    )
    op.execute("ALTER TABLE pending_attachment_groups ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON pending_attachment_groups FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("pending_attachment_groups")
