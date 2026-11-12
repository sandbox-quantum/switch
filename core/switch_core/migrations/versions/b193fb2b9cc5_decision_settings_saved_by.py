"""decision settings: who saved them

`decision_settings.saved_by` is the user whose save wrote the row: the
person in Switch Console or the gateway, or the owner of the agent that ran
`set_decision_routing`. An agent's tool may replace or clear only a row its
owner saved, so a prompt-injected agent can't remove another admin's
endpoint and key. Deleting the user clears it; a row from before this
revision has none, and only a person can change it.

Expand only: a process from before this revision leaves the column unset,
which reads as saved by nobody an agent acts for.

Revision ID: b193fb2b9cc5
Revises: dd2046c13b23
Create Date: 2026-11-05 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b193fb2b9cc5"
down_revision: str | Sequence[str] | None = "dd2046c13b23"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "decision_settings"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("saved_by", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_decision_settings_saved_by",
        TABLE,
        "users",
        ["saved_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_decision_settings_saved_by", TABLE, type_="foreignkey")
    op.drop_column(TABLE, "saved_by")
