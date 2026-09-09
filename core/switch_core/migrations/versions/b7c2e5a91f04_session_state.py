"""give a session state that outlives the process holding it

Until now a session existed only in whichever process was talking to the host.
Everything the server has to answer after a restart — who owns a session, what
happened in it, which commands it accepted, where it may publish — is derived
state that died with that process.

These six tables are that state at rest. Three of the constraints carry rules
rather than tidiness: the partial unique index on `session_commands` *is* the
reservation that stops two people answering one request, the partial unique
index on `session_events` refuses a host's retry rather than logging it twice,
and the primary keys on `session_leases` and `session_room_associations` mean a
second owner and a second publication room are refused by the table.

Revision ID: b7c2e5a91f04
Revises: a1d6f4b73c90
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "b7c2e5a91f04"
down_revision: str | Sequence[str] | None = "a1d6f4b73c90"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=True),
        sa.Column("capabilities", JSONB, nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "session_leases",
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("host_id", sa.Text(), nullable=False),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column(
            "acquired_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id"),
    )

    op.create_table(
        "session_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column("host_sequence", sa.BigInteger(), nullable=True),
        sa.Column("event_id", sa.Text(), nullable=False),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("body", JSONB, nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "session_id", "sequence", name="uq_session_events_sequence"
        ),
        sa.UniqueConstraint("session_id", "event_id", name="uq_session_events_event"),
    )
    op.create_index(
        "uq_session_events_host_sequence",
        "session_events",
        ["session_id", "epoch", "host_sequence"],
        unique=True,
        postgresql_where=sa.text("host_sequence IS NOT NULL"),
    )

    op.create_table(
        "session_commands",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=False),
        sa.Column("epoch", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("origin", JSONB, nullable=False),
        sa.Column("body", JSONB, nullable=False),
        sa.Column("request_id", sa.Text(), nullable=True),
        sa.Column("expected_revision", sa.Integer(), nullable=True),
        sa.Column("delivery_position", sa.BigInteger(), nullable=False),
        sa.Column("code", sa.Text(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("session_id", "command_id", name="uq_session_commands_id"),
        sa.UniqueConstraint(
            "session_id", "delivery_position", name="uq_session_commands_position"
        ),
    )
    op.create_index(
        "uq_session_commands_reservation",
        "session_commands",
        ["session_id", "epoch", "request_id", "expected_revision"],
        unique=True,
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )

    op.create_table(
        "session_room_associations",
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("origin_message_id", sa.Text(), nullable=True),
        sa.Column("granted_by_actor_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["room_id"], ["rooms.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("session_id"),
    )

    op.create_table(
        "session_publications",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column(
            "attempts", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("external_post_id", sa.Text(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["bridge_id"], ["collaboration_bridges.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "bridge_id",
            "session_id",
            "request_id",
            name="uq_session_publications_request",
        ),
    )
    op.create_index(
        "ix_session_publications_unresolved",
        "session_publications",
        ["updated_at"],
        postgresql_where=sa.text("state IN ('intended', 'in-flight')"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_session_publications_unresolved", table_name="session_publications"
    )
    op.drop_table("session_publications")
    op.drop_table("session_room_associations")
    op.drop_index("uq_session_commands_reservation", table_name="session_commands")
    op.drop_table("session_commands")
    op.drop_index("uq_session_events_host_sequence", table_name="session_events")
    op.drop_table("session_events")
    op.drop_table("session_leases")
    op.drop_table("sessions")
