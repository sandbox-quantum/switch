"""The controller connection last opened, so any process can hold it

Revision ID: c8f2a6d4e1b9
Revises: b3e9d4a1c7f2
Create Date: 2026-10-14

A controller opens its connection with one request and attaches its socket
with another, and a socket that drops reattaches with a third. With more than
one switch-core process these may reach different processes, so the
connection the controller last opened is recorded on its row: its id, its
generation, the process holding it and where its stream resumes each agent.
The process the socket reaches reads them, holds the connection itself and
records that it does, and any other process holding a copy closes it.

Expand only: the columns are nullable, and a process from before this
revision neither reads nor writes them.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c8f2a6d4e1b9"
down_revision: str | None = "b3e9d4a1c7f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "agent_controllers", sa.Column("open_connection_id", sa.Text(), nullable=True)
    )
    op.add_column(
        "agent_controllers",
        sa.Column("open_generation", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "agent_controllers", sa.Column("open_process_id", sa.Text(), nullable=True)
    )
    op.add_column(
        "agent_controllers",
        sa.Column("open_cursors", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_controllers", "open_cursors")
    op.drop_column("agent_controllers", "open_process_id")
    op.drop_column("agent_controllers", "open_generation")
    op.drop_column("agent_controllers", "open_connection_id")
