"""agent definitions: drop auto_session

A managed agent always starts a session when it is addressed, so the v1
definition no longer has an `auto_session` field. Stored definitions lose the
key; the definition schema refuses fields it does not know.

Revision ID: d2a7f4c9e1b8
Revises: b7e2c9d4a1f6
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d2a7f4c9e1b8"
down_revision: str | Sequence[str] | None = "b7e2c9d4a1f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE agent_definitions SET definition = definition - 'auto_session' "
        "WHERE definition ? 'auto_session'"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE agent_definitions "
        "SET definition = definition || '{\"auto_session\": true}'::jsonb"
    )
