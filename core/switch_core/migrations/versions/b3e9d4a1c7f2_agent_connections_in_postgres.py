"""Agent connections in Postgres, so every switch-core process can see them

Revision ID: b3e9d4a1c7f2
Revises: e5956cbd3bdc
Create Date: 2026-10-14

An agent's connection (its socket, heartbeat and the frames it is owed) stays
in the memory of the process holding it. What the other processes need to
know about it is written here, on transitions only and never per heartbeat:

- `agent_connections`: one row per connection, naming the process that holds
  it and its current incarnation, written when it opens or is reattached and
  when it closes. It reads as live only while the holding process's lease in
  `switch_core_processes` is held.
- `agent_connection_rooms`: the rooms claimed on each connection. The primary
  key keeps at most one claimant per agent per room.
- `agent_session_placements`: which room each of an agent's sessions
  connected to, and over which connection.
- `agent_session_command_relays`: a session command waiting for the process
  holding the stream it must be written to (the agent's watcher, or its
  controller's).
- `agent_connection_incarnation`: the sequence incarnations are drawn from,
  above 2**33 so no number matches one a client holds from the per-process
  counters used before, and below 2**53 so a JavaScript client holds it
  exactly.

Expand only: a process from before this revision keeps its agent connections
in memory and never reads these tables.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3e9d4a1c7f2"
down_revision: str | None = "e5956cbd3bdc"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)

_TABLES = (
    "agent_connections",
    "agent_connection_rooms",
    "agent_session_placements",
    "agent_session_command_relays",
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


def _room_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["tenant_id", "room_id"],
        ["rooms.tenant_id", "rooms.id"],
        name=f"fk_{table}_room",
        ondelete="CASCADE",
    )


def _connection_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["tenant_id", "connection_id"],
        ["agent_connections.tenant_id", "agent_connections.id"],
        name=f"fk_{table}_connection",
        ondelete="CASCADE",
    )


def upgrade() -> None:
    op.execute(
        "CREATE SEQUENCE agent_connection_incarnation"
        " START WITH 8589934592"
        " MINVALUE 8589934592"
        " MAXVALUE 9007199254740991"
        " NO CYCLE"
    )
    op.create_table(
        "agent_connections",
        _tenant("agent_connections"),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("process_id", sa.Text(), nullable=False),
        sa.Column("incarnation", sa.BigInteger(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("delivery_filter", sa.Text(), nullable=False),
        sa.Column("spawn_capable", sa.Boolean(), nullable=False),
        sa.Column("transport", sa.Text(), nullable=False),
        sa.Column("speaks", sa.Integer(), nullable=True),
        sa.Column("accepts", sa.Integer(), nullable=True),
        sa.Column(
            "attached_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("close_reason", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_agent_connections_id_tenant"),
        _agent_fk("agent_connections"),
    )
    op.create_index("ix_agent_connections_agent_id", "agent_connections", ["agent_id"])
    op.create_table(
        "agent_connection_rooms",
        _tenant("agent_connection_rooms"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("connection_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        _agent_fk("agent_connection_rooms"),
        _room_fk("agent_connection_rooms"),
        _connection_fk("agent_connection_rooms"),
    )
    op.create_index(
        "ix_agent_connection_rooms_connection_id",
        "agent_connection_rooms",
        ["connection_id"],
    )
    op.create_table(
        "agent_session_placements",
        _tenant("agent_session_placements"),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("connection_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "session_id"),
        sa.UniqueConstraint(
            "agent_id", "room_id", name="uq_agent_session_placements_agent_room"
        ),
        _agent_fk("agent_session_placements"),
        _room_fk("agent_session_placements"),
        _connection_fk("agent_session_placements"),
    )
    op.create_index(
        "ix_agent_session_placements_connection_id",
        "agent_session_placements",
        ["connection_id"],
    )
    op.create_table(
        "agent_session_command_relays",
        _tenant("agent_session_command_relays"),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("process_id", sa.Text(), nullable=False),
        sa.Column("frame", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        _agent_fk("agent_session_command_relays"),
    )
    op.create_index(
        "ix_agent_session_command_relays_process_id",
        "agent_session_command_relays",
        ["process_id"],
    )
    for table in _TABLES:
        op.create_index(f"ix_{table}_tenant_id", table, ["tenant_id"])
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(table=table))


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.drop_table(table)
    op.execute("DROP SEQUENCE IF EXISTS agent_connection_incarnation")
