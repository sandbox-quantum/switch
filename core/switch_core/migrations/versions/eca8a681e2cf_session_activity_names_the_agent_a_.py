"""session activity names the agent a subagent call runs

`session_activity_items.subagent` is `{"agent": <name or null>}` on a tool
call's row when the call starts a subagent, so platforms can draw it as one.
Existing rows, and every other row, have none.

Expand only: a process from before this revision neither reads nor writes the
column.

Revision ID: eca8a681e2cf
Revises: a3d9f6c2b871
Create Date: 2026-10-31 22:57:14.350940

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "eca8a681e2cf"
down_revision: str | None = "a3d9f6c2b871"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "session_activity_items",
        sa.Column("subagent", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("session_activity_items", "subagent")
