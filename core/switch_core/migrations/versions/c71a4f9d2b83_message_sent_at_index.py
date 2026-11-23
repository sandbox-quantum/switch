"""index messages by room and sent_at

The read path filters history by time window and orders it by `seq`. `seq`
already has an index through the room uniqueness constraint; `sent_at` had
none, so a windowed read had to scan the room.

Revision ID: c71a4f9d2b83
Revises: b5d2e08c17af
Create Date: 2026-09-03 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c71a4f9d2b83"
down_revision: str | None = "b5d2e08c17af"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_messages_room_sent_at", "messages", ["room_id", "sent_at"])


def downgrade() -> None:
    op.drop_index("ix_messages_room_sent_at", table_name="messages")
