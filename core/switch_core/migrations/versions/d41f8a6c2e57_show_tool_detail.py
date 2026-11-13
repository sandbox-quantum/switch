"""whether a room may see its agents' tool calls in detail

`rooms.show_tool_detail` says whether a room may see what its agents' tool
calls were given and gave back, redacted, in the messages that report their
work. It starts off, for every room that exists and every one made after.

`session_activity_items.detail` holds what a tool call's row may show of the
call, kept apart from its `text`: stored only while the room has it on, and
drawn only while it still does.

Expand only: a release from before this revision never reads these columns,
and shows no tool detail, as it never did.

Revision ID: d41f8a6c2e57
Revises: 861ff8767cf4
Create Date: 2026-10-28 03:10:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d41f8a6c2e57"
down_revision: str | None = "861ff8767cf4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "rooms",
        sa.Column(
            "show_tool_detail", sa.Boolean(), server_default="false", nullable=False
        ),
    )
    op.add_column(
        "session_activity_items", sa.Column("detail", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("session_activity_items", "detail")
    op.drop_column("rooms", "show_tool_detail")
