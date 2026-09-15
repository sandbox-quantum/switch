"""record the options a request card offered

A pressed button hands back the option it stands for. A typed answer does not:
"R42 1" names a position on the card the person is looking at, and nothing else
in Switch holds what that card offered. So the row keeps the options in the
order they were rendered, and a number resolves against them rather than
against whatever the request has since become.

Revision ID: b6d20e5a91c4
Revises: d94b7e0a3c15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "b6d20e5a91c4"
down_revision: str | Sequence[str] | None = "d94b7e0a3c15"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_request_posts",
        sa.Column(
            "options",
            JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("session_request_posts", "options")
