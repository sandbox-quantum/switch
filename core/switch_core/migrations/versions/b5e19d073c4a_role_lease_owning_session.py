"""Record the session that holds a role lease

Revision ID: b5e19d073c4a
Revises: c4d8e2a1f6b3
Create Date: 2026-09-22

A lease has always been kept alive by either its own heartbeat or the agent
having some live connection. The second test is agent-wide, so once an agent
holds one permanent controller connection it is always true and no lease
would ever expire. Naming the holding session is what lets liveness follow the
holder instead of the agent.

Nullable and backfilled with nothing: existing leases were taken by a holder
that renews its own heartbeat, which is still all they need.
"""

import sqlalchemy as sa
from alembic import op

revision = "b5e19d073c4a"
down_revision = "c4d8e2a1f6b3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("role_leases", sa.Column("session_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("role_leases", "session_id")
