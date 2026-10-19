"""ownership leases, and a delivery cursor per membership

`ownership_leases` records which switch-core process runs each piece of work
that must run once when several processes share the database: a client's
consumer, a collaboration bridge's platform connection, a server-side
connector. A holder counts only while its own lease in
`switch_core_processes` holds, and its row goes back to nobody when that
lease is pruned. A global table: no tenant column and no row-level security
policy (`db/rls_ddl.py`'s `GLOBAL_TABLES`).

`delivery_cursors` was keyed by agent and never written. It becomes how far
each client's consumer has handled each room it is a member of, keyed by the
membership and deleted with it, so the process that owns a client resumes
where the last owner stopped. `client_rooms` gains the unique key the cursor
refers to. Every existing membership starts at its room's newest row, which
is where a consumer started reading before this.

Revision ID: 340ead685ad6
Revises: be940bbaeaec
Create Date: 2026-10-14 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "340ead685ad6"
down_revision: str | None = "be940bbaeaec"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_POLICY = (
    "CREATE POLICY tenant_isolation ON delivery_cursors FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)

# Where every existing membership's consumer starts: the newest row of its
# room, or 0 for a room with none. Reconstructed history is numbered below
# zero and is never delivered.
_SEED_CURSORS = """
INSERT INTO delivery_cursors (tenant_id, client_id, room_id, last_seq)
SELECT m.tenant_id, m.client_id, m.room_id,
       GREATEST(COALESCE(
           (SELECT max(seq) FROM messages WHERE messages.room_id = m.room_id), 0
       ), 0)
FROM client_rooms m
"""


def upgrade() -> None:
    op.create_table(
        "ownership_leases",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("process_id", sa.Text(), nullable=True),
        sa.Column("token", sa.BigInteger(), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["process_id"],
            ["switch_core_processes.id"],
            name="fk_ownership_leases_process",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("kind", "key"),
    )
    op.create_index(
        "ix_ownership_leases_process_id", "ownership_leases", ["process_id"]
    )

    op.create_unique_constraint(
        "uq_client_rooms_tenant_client_room",
        "client_rooms",
        ["tenant_id", "client_id", "room_id"],
    )

    op.drop_table("delivery_cursors")
    op.create_table(
        "delivery_cursors",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_delivery_cursors_tenant"),
            nullable=False,
        ),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "client_id", "room_id"],
            [
                "client_rooms.tenant_id",
                "client_rooms.client_id",
                "client_rooms.room_id",
            ],
            name="fk_delivery_cursors_membership",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("client_id", "room_id"),
    )
    op.create_index("ix_delivery_cursors_tenant_id", "delivery_cursors", ["tenant_id"])
    op.execute("ALTER TABLE delivery_cursors ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY)
    op.execute(_SEED_CURSORS)


def downgrade() -> None:
    op.drop_table("delivery_cursors")
    op.create_table(
        "delivery_cursors",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_delivery_cursors_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_delivery_cursors_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_delivery_cursors_room",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "agent_id", "room_id", name="uq_delivery_cursors_agent_room"
        ),
    )
    op.create_index("ix_delivery_cursors_tenant_id", "delivery_cursors", ["tenant_id"])
    op.execute("ALTER TABLE delivery_cursors ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY)
    op.drop_constraint(
        "uq_client_rooms_tenant_client_room", "client_rooms", type_="unique"
    )
    op.drop_index("ix_ownership_leases_process_id", table_name="ownership_leases")
    op.drop_table("ownership_leases")
