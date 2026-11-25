"""license_acceptances, organizations.setup_answers: onboarding's two records

`license_acceptances` keeps who accepted which version of the license, and
when, which creating an organization asks for first where a version is set
(`gateway/licenses.py`). A global table, like `users`: no tenant column and no
row-level security policy (`db/rls_ddl.py`'s `GLOBAL_TABLES`). Its rows go
with the account.

`organizations.setup_answers` keeps what an organization's creator answered
about it when setting it up.

Expand only: a release before this one neither reads nor writes either.

Revision ID: f6a1c9d3b852
Revises: e3b8f2a61d47
Create Date: 2026-11-25 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f6a1c9d3b852"
down_revision: str | Sequence[str] | None = "e3b8f2a61d47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "license_acceptances",
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("version", sa.Text(), primary_key=True),
        sa.Column(
            "accepted_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.add_column(
        "organizations",
        sa.Column(
            "setup_answers", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )


def downgrade() -> None:
    op.drop_column("organizations", "setup_answers")
    op.drop_table("license_acceptances")
