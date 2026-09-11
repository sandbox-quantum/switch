"""Persist shared SDK sessions, leases, events and command reservations."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "d8a6c2e4f901"
down_revision = "c8e4a10b7f36"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sdk_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("agent_id", sa.Text(), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("host_id", sa.Text(), nullable=False),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("snapshot", postgresql.JSONB(), nullable=False),
        sa.Column("host_sequence", sa.BigInteger(), nullable=False),
    )
    op.create_table(
        "sdk_session_events",
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("sdk_sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("sequence", sa.BigInteger(), primary_key=True),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column("event_id", sa.Text(), nullable=False),
        sa.Column("host_sequence", sa.BigInteger(), nullable=True),
        sa.Column("host_event", postgresql.JSONB(), nullable=True),
        sa.Column("event", postgresql.JSONB(), nullable=False),
        sa.UniqueConstraint("session_id", "epoch", "host_sequence"),
        sa.UniqueConstraint("session_id", "event_id"),
    )
    op.create_table(
        "sdk_session_commands",
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("sdk_sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("command_id", sa.Text(), primary_key=True),
        sa.Column("accepted_sequence", sa.BigInteger(), nullable=False),
        sa.Column("command", postgresql.JSONB(), nullable=False),
        sa.Column("status", postgresql.JSONB(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("sdk_session_commands")
    op.drop_table("sdk_session_events")
    op.drop_table("sdk_sessions")
