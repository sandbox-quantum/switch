"""link prompts: confirm a chat account link by tapping a number

A link from a chat account to a Switch user can now be confirmed without a
code (CHOO-4121): Switch's bot messages the account a few numbers, Switch
Console shows the Switch user the right one, and tapping it confirms the link.

`external_user_link_requests` gains the prompt sent with the current code: the
token its buttons carry, the numbers it offered and the right one. The token
is looked up on every press, hence the partial unique index.

`external_users` gains a per-account count of prompts sent in the current
window, so starting links cannot be used to make the bot message someone over
and over.

Expand only: every column is nullable or defaulted, and a release from before
this revision never reads or writes them.

Revision ID: c8e4a1f7d392
Revises: d3a8f1c62b07
Create Date: 2026-11-05 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c8e4a1f7d392"
down_revision: str | Sequence[str] | None = "d3a8f1c62b07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "external_user_link_requests",
        sa.Column("prompt_token", sa.Text(), nullable=True),
    )
    op.add_column(
        "external_user_link_requests",
        sa.Column("prompt_choices", postgresql.ARRAY(sa.Integer()), nullable=True),
    )
    op.add_column(
        "external_user_link_requests",
        sa.Column("prompt_number", sa.Integer(), nullable=True),
    )
    op.create_index(
        "uq_external_user_link_requests_prompt_token",
        "external_user_link_requests",
        ["prompt_token"],
        unique=True,
        postgresql_where=sa.text("prompt_token IS NOT NULL"),
    )
    op.add_column(
        "external_users",
        sa.Column(
            "link_prompts_sent",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
    )
    op.add_column(
        "external_users",
        sa.Column(
            "link_prompt_window_started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("external_users", "link_prompt_window_started_at")
    op.drop_column("external_users", "link_prompts_sent")
    op.drop_index(
        "uq_external_user_link_requests_prompt_token",
        table_name="external_user_link_requests",
    )
    op.drop_column("external_user_link_requests", "prompt_number")
    op.drop_column("external_user_link_requests", "prompt_choices")
    op.drop_column("external_user_link_requests", "prompt_token")
