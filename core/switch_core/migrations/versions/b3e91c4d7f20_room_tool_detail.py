"""a per-room switch for tool detail, and the detail kept with a tool call

`rooms.tool_detail` says whether a tool call's redacted input and output, as
its host reports them, are kept and shown in the room. Every room starts with
it off, the column's default, including every room that exists today.

`session_activity_items.tool_detail` holds that detail for one tool call. It
is written only while the call's room has the switch on.

Expand only: a release from before this revision never reads either column.

Revision ID: b3e91c4d7f20
Revises: 10f6d02ac5bc
Create Date: 2026-11-02 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3e91c4d7f20"
down_revision: str | None = "10f6d02ac5bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column("tool_detail", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "session_activity_items",
        sa.Column("tool_detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_activity_items", "tool_detail")
    op.drop_column("rooms", "tool_detail")
