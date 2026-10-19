"""Agent events in Postgres: each agent's own events and each reader's position

Revision ID: a7e3c1d9f204
Revises: 7c3e91a4d5b2
Create Date: 2026-10-12

Creates the tables that hold each agent's queued events and each reader's
place in them, so they survive a restart and every server process sees the
same data:

- `agent_events`: each agent's own events. A row is an event meant for the
  agent, not one it sent (an addressed message, a join it listens for, a task
  event, a command), numbered per agent in `seq`, with `room_seq` and
  `message_key` naming the room row it came from. The rest of a room's conversation stays in
  `messages` and is not copied.
- `agent_event_heads`: the first and latest `seq` given out per agent, so a
  number is never given out twice after old rows are deleted.
- `agent_event_drops`: per agent and room, the newest `seq` that retention
  deleted, so a client resuming from below it is told it has a gap.
- `agent_room_reads`: per agent and room, the `messages.seq` the agent last
  caught up through and who is in the room, the baseline for the unread
  count.
- `agent_poll_positions`: the position the server keeps for each long-poll
  endpoint, since long-polling clients send none.
- `agent_position_tickets`: positions stored under a single number for
  clients that can hold only one integer.

It also creates a trigger that sends a `NOTIFY` on `switch_agent_event` for
each insert into `agent_events`, which wakes the process holding the agent's
connection so it reads the new rows.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a7e3c1d9f204"
down_revision = "7c3e91a4d5b2"
branch_labels = None
depends_on = None

# Copies of the DDL in `db/agent_event_notify_ddl.py`, written out here so
# this migration keeps creating the same objects if that module changes.
CREATE_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_agent_event() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'switch_agent_event',
        json_build_object('agent_id', NEW.agent_id, 'seq', NEW.seq)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_NOTIFY_TRIGGER = """
CREATE TRIGGER agent_events_notify
    AFTER INSERT ON agent_events
    FOR EACH ROW EXECUTE FUNCTION switch_notify_agent_event()
"""

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def _tenant(table: str) -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        "tenant_id",
        sa.Text(),
        sa.ForeignKey("tenants.id", name=f"fk_{table}_tenant"),
        nullable=False,
    )


def _agent_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["tenant_id", "agent_id"],
        ["agents.tenant_id", "agents.id"],
        name=f"fk_{table}_agent",
        ondelete="CASCADE",
    )


def upgrade() -> None:
    op.create_table(
        "agent_events",
        _tenant("agent_events"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("room_seq", sa.BigInteger(), nullable=False),
        sa.Column("message_key", sa.Text(), nullable=True),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=False),
        sa.Column("notifiable", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "seq"),
        _agent_fk("agent_events"),
    )
    op.create_index("ix_agent_events_created_at", "agent_events", ["created_at"])
    op.create_index(
        "ix_agent_events_agent_room_seq",
        "agent_events",
        ["tenant_id", "agent_id", "room_id", "room_seq"],
    )
    op.create_index(
        "ix_agent_events_agent_message_key",
        "agent_events",
        ["agent_id", "message_key"],
    )
    op.create_table(
        "agent_event_heads",
        _tenant("agent_event_heads"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("first_seq", sa.BigInteger(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id"),
        _agent_fk("agent_event_heads"),
    )
    op.create_table(
        "agent_event_drops",
        _tenant("agent_event_drops"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("dropped_through", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        _agent_fk("agent_event_drops"),
    )
    op.create_table(
        "agent_room_reads",
        _tenant("agent_room_reads"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("caught_up_seq", sa.BigInteger(), nullable=False),
        sa.Column("occupant_id", sa.Text(), nullable=False),
        sa.Column("occupant_is_session", sa.Boolean(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        _agent_fk("agent_room_reads"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_room_reads_room",
            ondelete="CASCADE",
        ),
    )
    op.create_table(
        "agent_poll_positions",
        _tenant("agent_poll_positions"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("reader_id", sa.Text(), nullable=False),
        sa.Column("position", postgresql.JSONB(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("agent_id", "reader_id"),
        _agent_fk("agent_poll_positions"),
    )
    # Ticket ids run from (2097150 + 1) << 32, above every agent event number
    # (an agent's numbers start at its boot number, at most 2097150 by the
    # `agent_event_boot` sequence, shifted left 32 bits), to 2**53 - 1, the
    # largest integer a JavaScript client holds exactly. The server tells a
    # ticket id from an event number by size. Values are written out because a
    # migration must not change when the code's constants do.
    op.execute(
        "CREATE SEQUENCE agent_position_ticket"
        " START WITH 9007194959773696"
        " MINVALUE 9007194959773696"
        " MAXVALUE 9007199254740991"
        " CYCLE"
    )
    op.create_table(
        "agent_position_tickets",
        _tenant("agent_position_tickets"),
        sa.Column(
            "id",
            sa.BigInteger(),
            server_default=sa.text("nextval('agent_position_ticket')"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("position", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        _agent_fk("agent_position_tickets"),
    )
    op.create_index(
        "ix_agent_position_tickets_created_at",
        "agent_position_tickets",
        ["created_at"],
    )
    for table in (
        "agent_events",
        "agent_event_heads",
        "agent_event_drops",
        "agent_room_reads",
        "agent_poll_positions",
        "agent_position_tickets",
    ):
        op.create_index(f"ix_{table}_tenant_id", table, ["tenant_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(table=table))
    op.execute(CREATE_NOTIFY_FUNCTION)
    op.execute(CREATE_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS agent_events_notify ON agent_events")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_agent_event()")
    op.drop_table("agent_position_tickets")
    op.execute("DROP SEQUENCE IF EXISTS agent_position_ticket")
    op.drop_table("agent_poll_positions")
    op.drop_table("agent_room_reads")
    op.drop_table("agent_event_drops")
    op.drop_table("agent_event_heads")
    op.drop_table("agent_events")
