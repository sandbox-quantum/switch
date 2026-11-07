"""messages: the message a row is an edit of

`messages.replaces_event_id` names the message a row replaces, read out of the
row's `m.replace` relation the way `thread_root_event_id` is read out of its
`m.thread` relation. An edit of a message is a row of its own that carries the
new text; the original row is never rewritten, and a reader shows the latest
edit in its place. The partial index finds a message's edits by the room and
the message, which is how the read path asks for them.

Expand only: rows written before this revision have no edits and stay NULL.

Revision ID: c4e1a7d2b9f3
Revises: 10f6d02ac5bc
Create Date: 2026-11-08 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e1a7d2b9f3"
down_revision: str | None = "10f6d02ac5bc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("replaces_event_id", sa.Text(), nullable=True))
    op.create_index(
        "ix_messages_replaces",
        "messages",
        ["room_id", "replaces_event_id"],
        unique=False,
        postgresql_where=sa.text("replaces_event_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_messages_replaces",
        table_name="messages",
        postgresql_where=sa.text("replaces_event_id IS NOT NULL"),
    )
    op.drop_column("messages", "replaces_event_id")
