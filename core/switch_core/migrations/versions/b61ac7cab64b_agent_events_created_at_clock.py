"""agent events: ``created_at`` is when the event was inserted

``agent_events.created_at`` defaulted to ``now()``, the start of the
transaction. A transaction that began earlier can number its event later, so a
higher ``seq`` could carry an earlier ``created_at`` than a lower one. Retention
deletes by ``created_at`` and a resuming reader takes everything numbered below
what retention kept to be gone, so the first could be deleted and the second
kept, and the reader would skip the second without being told.

``clock_timestamp()`` is the time of the insert, which happens under the
agent's head row after every lower number has been inserted. Rows already
stored keep their ``created_at``; any that were out of order have gone once
retention has passed.

Expand only: a process from before this revision inserts with the old default
until the column changes, and again as it was after a downgrade.

Revision ID: b61ac7cab64b
Revises: f3a8d1c6b927
Create Date: 2026-11-07 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b61ac7cab64b"
down_revision: str | None = "7105e0bea527"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.execute(
        "ALTER TABLE agent_events ALTER COLUMN created_at SET DEFAULT clock_timestamp()"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE agent_events ALTER COLUMN created_at SET DEFAULT now()")
