"""remember which chat a messaging install claim was proposed in

`messaging_install_states.proposed_chat_id` names the chat a claim-based
install (Telegram) was put to when its state was redeemed. Only an answer from
that chat may decide the state. It was held in the memory of the process that
posted the proposal, so an admin's Connect reaching another switch-core process
was refused as expired. Existing rows have nothing proposed.

Expand only: a process from before this revision holds its proposals in
memory and never reads the column.

Revision ID: 5f97c7c7407a
Revises: 1feaa7700723
Create Date: 2026-10-14 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5f97c7c7407a"
down_revision: str | None = "1feaa7700723"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "messaging_install_states",
        sa.Column("proposed_chat_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messaging_install_states", "proposed_chat_id")
