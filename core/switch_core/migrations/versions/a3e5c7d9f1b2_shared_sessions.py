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

Revision ID: a3e5c7d9f1b2
Revises: c7715ebb95c9
Create Date: 2026-10-21 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3e5c7d9f1b2"
down_revision: str | Sequence[str] | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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


def downgrade() -> None:
    op.drop_column("room_agents", "shared_session")
    op.drop_column("agents", "sharing_locked")
    op.drop_column("agents", "shared_by_default")
    op.drop_column("agents", "home_room_id")
