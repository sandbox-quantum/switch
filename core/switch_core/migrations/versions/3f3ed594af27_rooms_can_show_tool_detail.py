"""rooms can show their agents' tool detail

`rooms.show_tool_detail` is a room's switch for showing what its agents'
tool calls were given and gave back, off for every room until its owner or a
workspace admin turns it on. `session_activity_items.detail` keeps a tool
call's redacted preview while its room's switch is on.

Expand only: a process from before this revision neither reads nor writes
either column, and the switch has a server default.

Revision ID: 3f3ed594af27
Revises: a4c7e2d9b813
Create Date: 2026-11-01 00:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3f3ed594af27"
down_revision: str | None = "a4c7e2d9b813"
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
        "session_activity_items",
        sa.Column("detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_activity_items", "detail")
    op.drop_column("rooms", "show_tool_detail")
