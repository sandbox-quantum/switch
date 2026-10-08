"""agent management: the "can manage agents" capability and machine descriptions

- `agents.can_manage_agents`: whether the agent may list its owner's machines
  and managed agents, and create managed agents on those machines, through
  the agent operations. Off for every existing agent; only its owner turns it
  on.
- `agent_controllers.description`: an optional free-text description of the
  machine, set at enrollment and editable by its owner.

Revision ID: c4d8e1f2a9b3
Revises: d2a7f4c9e1b8
Create Date: 2026-10-03 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4d8e1f2a9b3"
down_revision: str | Sequence[str] | None = "d2a7f4c9e1b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "can_manage_agents",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.add_column(
        "agent_controllers", sa.Column("description", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("agent_controllers", "description")
    op.drop_column("agents", "can_manage_agents")
