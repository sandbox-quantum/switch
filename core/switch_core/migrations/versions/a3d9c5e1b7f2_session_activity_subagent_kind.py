"""Session activity items may be subagents

A subagent a turn spawned is its own step kind, so a platform can list the
running ones apart from tool calls. Widens the `kind` check only.

Revision ID: a3d9c5e1b7f2
Revises: b7e1d4c9a2f6
Create Date: 2026-10-31 00:00:00.000000
"""

from alembic import op

revision: str = "a3d9c5e1b7f2"
down_revision: str | None = "b7e1d4c9a2f6"
branch_labels = None
depends_on = None

_CONSTRAINT = "ck_session_activity_items_kind"
_TABLE = "session_activity_items"


def upgrade() -> None:
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        "kind IN ('turn', 'user-message', 'assistant-message', "
        "'tool-activity', 'subagent', 'notice')",
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM {_TABLE} WHERE kind = 'subagent'")
    op.drop_constraint(_CONSTRAINT, _TABLE, type_="check")
    op.create_check_constraint(
        _CONSTRAINT,
        _TABLE,
        "kind IN ('turn', 'user-message', 'assistant-message', "
        "'tool-activity', 'notice')",
    )
