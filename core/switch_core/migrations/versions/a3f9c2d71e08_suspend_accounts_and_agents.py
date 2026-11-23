"""suspended accounts and agents

A person or an agent can now be suspended: shut out at once, with nothing
deleted, and let back in by lifting it (`accounts/suspension.py`).
`suspended_at` says since when, `suspended_by` who did it (cleared when that
account is deleted), `suspended_reason` why, and `suspended_by_role` whether
it was the agent's owner, an admin of the workspace or organization, or the
server's operator, which decides who may lift it. An agent's
`suspended_with_owner` marks a suspension that came from suspending its owner.

Expand only: a release from before this revision reads none of the columns,
and only stops refusing what this one suspends.

Revision ID: a3f9c2d71e08
Revises: a3f9c1e7d205
Create Date: 2026-11-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f9c2d71e08"
down_revision: str | None = "a3f9c1e7d205"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def _add_suspension(table: str, roles: str) -> None:
    op.add_column(
        table, sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(table, sa.Column("suspended_by", sa.Text(), nullable=True))
    op.add_column(table, sa.Column("suspended_reason", sa.Text(), nullable=True))
    op.add_column(table, sa.Column("suspended_by_role", sa.Text(), nullable=True))
    op.create_foreign_key(
        f"fk_{table}_suspended_by",
        table,
        "users",
        ["suspended_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        f"ck_{table}_suspended_by_role", table, f"suspended_by_role IN ({roles})"
    )
    op.create_check_constraint(
        f"ck_{table}_suspension_complete",
        table,
        "(suspended_at IS NULL) = (suspended_by_role IS NULL)",
    )


def _drop_suspension(table: str) -> None:
    op.drop_constraint(f"ck_{table}_suspension_complete", table, type_="check")
    op.drop_constraint(f"ck_{table}_suspended_by_role", table, type_="check")
    op.drop_constraint(f"fk_{table}_suspended_by", table, type_="foreignkey")
    op.drop_column(table, "suspended_by_role")
    op.drop_column(table, "suspended_reason")
    op.drop_column(table, "suspended_by")
    op.drop_column(table, "suspended_at")


def upgrade() -> None:
    _add_suspension("users", "'admin', 'operator'")
    _add_suspension("agents", "'owner', 'admin', 'operator'")
    op.add_column(
        "agents",
        sa.Column(
            "suspended_with_owner",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("agents", "suspended_with_owner")
    _drop_suspension("agents")
    _drop_suspension("users")
