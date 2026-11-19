"""card answer: ``bridge_message_map.card_answer``

The press that answered an agent's card, recorded on the mapping of the post
the card became, so a card takes one answer. NULL is unanswered, which every
existing row is.

Expand only: a process from before this revision neither writes nor reads the
column, so it delivers every press, as before.

Revision ID: a4c7e2d9b813
Revises: ab802e19c401
Create Date: 2026-11-08 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a4c7e2d9b813"
down_revision: str | None = "ab802e19c401"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "bridge_message_map",
        sa.Column("card_answer", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bridge_message_map", "card_answer")
