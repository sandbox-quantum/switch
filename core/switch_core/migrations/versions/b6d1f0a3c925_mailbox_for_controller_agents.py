"""wake mailbox rows for agents on the shared agent controller

An agent a cloud machine runs on the agent controller is addressed while the
machine sleeps the way a hosted worker's agent is, and its events wait in the
same mailbox, keyed by agent. Such an agent may have no hosted launch, so
`hosted_wake_mailbox.launch_id` becomes nullable.

Downgrade deletes the rows that have no launch: they belong to no worker.

Revision ID: b6d1f0a3c925
Revises: 9e3b7c51a2d4
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b6d1f0a3c925"
down_revision: str | Sequence[str] | None = "9e3b7c51a2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("hosted_wake_mailbox", "launch_id", nullable=True)


def downgrade() -> None:
    op.execute("DELETE FROM hosted_wake_mailbox WHERE launch_id IS NULL")
    op.alter_column("hosted_wake_mailbox", "launch_id", nullable=False)
