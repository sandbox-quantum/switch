"""Structured tool detail on turn steps; tool, plan and reason on approvals

`session_activity_items.detail`: what a tool step called and, once it
finished, what came back, as the session host reported it.
`approval_requests.tool` and `.plan`: the tool call or plan an approval asks a
person to accept. `approval_requests.reason`: the person's words on declining
it, owed to the agent with the outcome.

Expand only: every column is nullable, and a release before this one neither
writes nor reads them. The session-activity trigger announces a turn step by
key and an approval request with `to_jsonb(NEW)`, so neither needs a change.

Revision ID: b3f6c9e2d417
Revises: a25845a0e7be
Create Date: 2026-11-26 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3f6c9e2d417"
down_revision: str | Sequence[str] | None = "a25845a0e7be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "session_activity_items",
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "approval_requests",
        sa.Column("tool", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column("approval_requests", sa.Column("plan", sa.Text(), nullable=True))
    op.add_column("approval_requests", sa.Column("reason", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("approval_requests", "reason")
    op.drop_column("approval_requests", "plan")
    op.drop_column("approval_requests", "tool")
    op.drop_column("session_activity_items", "detail")
