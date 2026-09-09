"""record where a session's request was posted

A pressed button hands back an opaque token and nothing else. This is what the
token is resolved against: which session, which epoch, which request and at
which revision, scoped to the bridge the token was minted for.

Nothing writes this table until the bridge posts request cards for real, so
applying it early costs nothing and keeps that change to code.

Revision ID: d94b7e0a3c15
Revises: c8e4a10b7f36
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d94b7e0a3c15"
down_revision: str | Sequence[str] | None = "c8e4a10b7f36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "session_request_posts",
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "bridge_id",
            sa.Text(),
            sa.ForeignKey("collaboration_bridges.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("handle", sa.Text(), nullable=False),
        sa.Column("external_channel_id", sa.Text(), nullable=False),
        sa.Column("external_post_id", sa.Text(), nullable=False),
        sa.Column(
            "room_id",
            sa.Text(),
            sa.ForeignKey("rooms.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("token", name="uq_session_request_posts_token"),
        sa.UniqueConstraint(
            "bridge_id",
            "session_id",
            "request_id",
            name="uq_session_request_posts_request",
        ),
        sa.UniqueConstraint(
            "bridge_id",
            "external_channel_id",
            "handle",
            name="uq_session_request_posts_handle",
        ),
    )


def downgrade() -> None:
    op.drop_table("session_request_posts")
