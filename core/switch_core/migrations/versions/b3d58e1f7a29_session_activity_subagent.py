"""the agent a tool call started, on that call's activity row

`session_activity_items.subagent` names the agent a tool call started, so a
platform can draw that call as the subagent it is rather than as one more tool
row. Only a tool call's row carries one (`ck_session_activity_items_subagent`).

The check is added `NOT VALID`, so adding it takes its lock for a moment and
scans nothing: `session_activity_items` is written by every pod, and a
validating scan would hold them all up behind its lock. There is nothing for a
scan to find, since the column is created here and every row already in the
table has it NULL; every row written from now on is checked. It is not
validated in a later step either, because `migrations/env.py` runs an upgrade
in one transaction, so a `VALIDATE CONSTRAINT` after it would still run under
the lock this addition takes.

Expand only: a release from before this revision never writes the column, so
every row it writes leaves it NULL and meets the check.

Revision ID: b3d58e1f7a29
Revises: f3a8d1c6b927
Create Date: 2026-10-28 00:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3d58e1f7a29"
down_revision: str | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_CHECK = "ck_session_activity_items_subagent"


def upgrade() -> None:
    op.add_column(
        "session_activity_items", sa.Column("subagent", sa.Text(), nullable=True)
    )
    op.execute(
        f"ALTER TABLE session_activity_items ADD CONSTRAINT {_CHECK} "
        "CHECK (subagent IS NULL OR kind = 'tool-activity') NOT VALID"
    )


def downgrade() -> None:
    op.drop_constraint(_CHECK, "session_activity_items", type_="check")
    op.drop_column("session_activity_items", "subagent")
