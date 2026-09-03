"""messages and message attachments

A parallel record of every message sent into a room, written alongside the
send. Nothing reads these tables yet; the read path moves onto them in a
later change.

Revision ID: a3f7c91b8e24
Revises: c81f4a06d2b7
Create Date: 2026-09-03 21:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a3f7c91b8e24"
down_revision: str | None = "c81f4a06d2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "messages",
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "seq",
            sa.BigInteger(),
            sa.Identity(always=True),
            unique=True,
            nullable=False,
        ),
        sa.Column(
            "room_id",
            sa.Text(),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("transport_event_id", sa.Text(), unique=True, nullable=False),
        sa.Column("sender_matrix_id", sa.Text(), nullable=False),
        sa.Column(
            "sender_client_id",
            sa.Text(),
            sa.ForeignKey("clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sender_name", sa.Text(), nullable=True),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("msgtype", sa.Text(), nullable=True),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("formatted_body", sa.Text(), nullable=True),
        sa.Column("thread_root_event_id", sa.Text(), nullable=True),
        sa.Column("content", JSONB(), nullable=False),
        sa.Column(
            "sent_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_messages_room_seq", "messages", ["room_id", "seq"])
    op.create_index(
        "ix_messages_thread_root",
        "messages",
        ["room_id", "thread_root_event_id"],
        postgresql_where=sa.text("thread_root_event_id IS NOT NULL"),
    )

    op.create_table(
        "message_attachments",
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "message_id",
            sa.Text(),
            sa.ForeignKey("messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("uri", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=True),
        sa.Column("mimetype", sa.Text(), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_message_attachments_message", "message_attachments", ["message_id"]
    )


def downgrade() -> None:
    op.drop_table("message_attachments")
    op.drop_table("messages")
