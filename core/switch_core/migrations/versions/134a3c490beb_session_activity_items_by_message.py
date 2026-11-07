"""session_activity_items: find a message's turns without scanning the room

A platform edit names a message rather than an agent, so the turns it may
correct are looked up by `(room_id, message_id)`. Nothing indexed that, and
each edit read every activity row in the workspace. Expand-only: an index is
added and nothing is changed or removed.

Revision ID: 134a3c490beb
Revises: a3d9f6c2b871
Create Date: 2026-11-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "134a3c490beb"
down_revision: str | Sequence[str] | None = "f3a8d1c6b927"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_session_activity_items_room_message",
        "session_activity_items",
        ["tenant_id", "room_id", "message_id"],
        postgresql_where=sa.text("message_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_session_activity_items_room_message", table_name="session_activity_items"
    )
