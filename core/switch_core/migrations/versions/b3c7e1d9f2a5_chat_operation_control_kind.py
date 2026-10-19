"""chat operations: a `control` kind for room commands posted from a chat

Revision ID: b3c7e1d9f2a5
Revises: e2a6c9f1b7d4
Create Date: 2026-10-14 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b3c7e1d9f2a5"
down_revision: str | Sequence[str] | None = "e2a6c9f1b7d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "chat_operations"
CONSTRAINT = "ck_chat_operations_kind"


def upgrade() -> None:
    op.drop_constraint(CONSTRAINT, TABLE, type_="check")
    op.create_check_constraint(
        CONSTRAINT, TABLE, "kind IN ('create_chat', 'send', 'upload', 'control')"
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM {TABLE} WHERE kind = 'control'")
    op.drop_constraint(CONSTRAINT, TABLE, type_="check")
    op.create_check_constraint(
        CONSTRAINT, TABLE, "kind IN ('create_chat', 'send', 'upload')"
    )
