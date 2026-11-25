"""users.first_signed_in_at: when the person first signed in, if ever

The WorkOS directory mirror makes an account for an organization member who
has never signed in to Switch, so that its admins see them and can add them
to a workspace. Such an account has no sign-in yet; the first one sets this.
Every existing account is taken as signed in when it was made.

Expand only: a release before this one writes no value for an account it
makes, which then reads as never signed in until its next sign-in.

Revision ID: b3e7c2a9d41f
Revises: a25845a0e7be
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3e7c2a9d41f"
down_revision: str | Sequence[str] | None = "a25845a0e7be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("first_signed_in_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE users SET first_signed_in_at = created_at")


def downgrade() -> None:
    op.drop_column("users", "first_signed_in_at")
