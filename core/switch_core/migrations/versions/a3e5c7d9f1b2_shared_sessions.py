"""shared sessions: an agent's home room and which of its rooms share its session

Three columns on `agents` and one on `room_agents`, all defaulting to "not
shared", so every existing agent keeps one session per room. There is no data
step.

- `agents.home_room_id`: the room the agent's shared session is based in;
  NULL means it shares no session.
- `agents.shared_by_default`: whether a room it is added to shares it.
- `agents.sharing_locked`: every room it is in shares it, and none can be
  made isolated.
- `room_agents.shared_session`: whether this room shares the agent's session.

And one table, `agent_session_shares`: the rooms a session answers for from
its home room, beside the placement `agent_session_placements` records, with
the same tenant policy.

And `room_token_usage`: what each agent's turns spent per room, hourly and
per model, so an agent answering several rooms can be costed per room. No
foreign keys beyond the tenant, so counts outlive their room and agent.

Revision ID: a3e5c7d9f1b2
Revises: f68b679599ab
Create Date: 2026-10-21 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3e5c7d9f1b2"
down_revision: str | Sequence[str] | None = "f68b679599ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def upgrade() -> None:
    op.add_column("agents", sa.Column("home_room_id", sa.Text(), nullable=True))
    op.add_column(
        "agents",
        sa.Column(
            "shared_by_default",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "agents",
        sa.Column(
            "sharing_locked",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.add_column(
        "room_agents",
        sa.Column(
            "shared_session",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )

    op.create_table(
        "agent_session_shares",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_agent_session_shares_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("connection_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("agent_id", "room_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_session_shares_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_session_shares_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "connection_id"],
            ["agent_connections.tenant_id", "agent_connections.id"],
            name="fk_agent_session_shares_connection",
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_agent_session_shares_connection_id",
        "agent_session_shares",
        ["connection_id"],
    )
    op.create_index(
        "ix_agent_session_shares_tenant_id", "agent_session_shares", ["tenant_id"]
    )
    op.execute("ALTER TABLE agent_session_shares ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="agent_session_shares"))

    op.create_table(
        "room_token_usage",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_room_token_usage_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("bucket_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("turns", sa.BigInteger(), nullable=False),
        sa.Column("input_tokens", sa.BigInteger(), nullable=False),
        sa.Column("output_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_read_tokens", sa.BigInteger(), nullable=False),
        sa.Column("cache_write_tokens", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint(
            "tenant_id", "agent_id", "room_id", "bucket_start", "model"
        ),
    )
    op.execute("ALTER TABLE room_token_usage ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="room_token_usage"))


def downgrade() -> None:
    op.drop_table("room_token_usage")
    op.drop_table("agent_session_shares")
    op.drop_column("room_agents", "shared_session")
    op.drop_column("agents", "sharing_locked")
    op.drop_column("agents", "shared_by_default")
    op.drop_column("agents", "home_room_id")
