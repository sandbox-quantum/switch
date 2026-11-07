"""Session activity items may be subagents

A subagent a turn spawned is its own step kind, so a platform can list the
running ones apart from tool calls. Widens the `kind` check only.

Marked `expand_only`: widening the check only relaxes the schema, so an older
pod keeps serving through a rolling upgrade. The constraint is added `NOT
VALID` and then validated so the table is not scanned under `ACCESS EXCLUSIVE`.

Revision ID: a3d9c5e1b7f2
Revises: f3a8d1c6b927
Create Date: 2026-10-31 00:00:00.000000
"""

from alembic import op

revision: str = "a3d9c5e1b7f2"
down_revision: str | None = "f3a8d1c6b927"
branch_labels = None
depends_on = None
expand_only: bool = True

_CONSTRAINT = "ck_session_activity_items_kind"
_TABLE = "session_activity_items"


def upgrade() -> None:
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} "
        "CHECK (kind IN ('turn', 'user-message', 'assistant-message', "
        "'tool-activity', 'subagent', 'notice')) NOT VALID"
    )
    op.execute(f"ALTER TABLE {_TABLE} VALIDATE CONSTRAINT {_CONSTRAINT}")


def downgrade() -> None:
    op.execute(f"DELETE FROM {_TABLE} WHERE kind = 'subagent'")
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.execute(
        f"ALTER TABLE {_TABLE} ADD CONSTRAINT {_CONSTRAINT} "
        "CHECK (kind IN ('turn', 'user-message', 'assistant-message', "
        "'tool-activity', 'notice')) NOT VALID"
    )
