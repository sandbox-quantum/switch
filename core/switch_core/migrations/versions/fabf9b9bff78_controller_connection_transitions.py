"""agent controllers: record connection transitions and process leases

Four nullable columns on `agent_controllers` recording the controller's
connection as the switch-core process holding its socket last wrote it:
which connection, which process holds it, when its socket attached, and when
and why it went. Existing rows start with all null and fill in when their
controller next connects.

`switch_core_processes` holds each switch-core process's lease, renewed every
few seconds, so a connection whose process died without writing its closing
reads as offline. A global table: no tenant column and no row-level security
policy (`db/rls_ddl.py`'s `GLOBAL_TABLES`).

Revision ID: fabf9b9bff78
Revises: eb24eafa59a0
Create Date: 2026-10-07 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "fabf9b9bff78"
down_revision: str | None = "eb24eafa59a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "switch_core_processes",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "beat_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("stopped_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.add_column(
        "agent_controllers", sa.Column("connection_id", sa.Text(), nullable=True)
    )
    op.add_column(
        "agent_controllers",
        sa.Column("connection_process_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "agent_controllers",
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_controllers",
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_controllers", sa.Column("disconnect_reason", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("agent_controllers", "disconnect_reason")
    op.drop_column("agent_controllers", "disconnected_at")
    op.drop_column("agent_controllers", "connected_at")
    op.drop_column("agent_controllers", "connection_process_id")
    op.drop_column("agent_controllers", "connection_id")
    op.drop_table("switch_core_processes")
