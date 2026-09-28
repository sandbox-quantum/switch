"""Let several SDK sessions share one inbound connection

Revision ID: 7f1c0b93ae52
Revises: b5e19d073c4a
Create Date: 2026-09-22

One agent is meant to have one inbound connection carrying every session it
runs, so a connection can no longer identify a session and the uniqueness that
said it could has to go. What identifies a session is its own id, fenced by
host and epoch; the connection is the route its events take.

The downgrade recreates the constraint, which will fail if sessions are
already sharing a connection by then. That is the honest outcome: the rows
would have to be reconciled by hand, and silently dropping one is worse.
"""

from alembic import op

revision = "7f1c0b93ae52"
down_revision = "b5e19d073c4a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_sdk_sessions_connection_id", "sdk_sessions", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint(
        "uq_sdk_sessions_connection_id", "sdk_sessions", ["tenant_id", "connection_id"]
    )
