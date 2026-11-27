"""agent management: an operation's latest progress, and input for it

A browser sign-in on a machine (`provider.login` with `method: "browser"`)
runs for minutes and needs the owner in the middle of it: the controller
reports the sign-in page (and a code to type there, or that it waits for one
pasted back) as progress, and the owner sends the code the page showed.
`progress` keeps the controller's latest progress report for the owner to
read; `input` holds what the owner sent until the controller takes it, then
only that it was taken.

Expand only: a release from before this revision reads neither column.

Revision ID: a6d3f1c8e925
Revises: 5c50c7ae76dd
Create Date: 2026-11-26 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a6d3f1c8e925"
down_revision: str | None = "5c50c7ae76dd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "agent_controller_operations"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("progress", postgresql.JSONB(), nullable=True))
    op.add_column(TABLE, sa.Column("input", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column(TABLE, "input")
    op.drop_column(TABLE, "progress")
