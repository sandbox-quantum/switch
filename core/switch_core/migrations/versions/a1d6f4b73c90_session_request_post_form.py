"""record which sort of answer a request card takes, not just its options

A card is either an approval, which takes one option, or a set of questions,
which takes an answer to each. Both are answered by number, so the row has to
carry the numbering either way — but it also has to say which of the two it is,
because the same press builds a different result on each and a list of options
looks the same from the outside.

So `options` becomes `form`, discriminated by `kind`: the reader asks the record
what the card was rather than inferring it from which key is populated.

Revision ID: a1d6f4b73c90
Revises: c3f1a7d5be82
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a1d6f4b73c90"
down_revision: str | Sequence[str] | None = "c3f1a7d5be82"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("session_request_posts", sa.Column("form", JSONB, nullable=True))
    # Every row written so far is an approval: nothing else could be posted yet.
    op.execute(
        "UPDATE session_request_posts "
        "SET form = jsonb_build_object('kind', 'approval', 'options', options)"
    )
    op.alter_column("session_request_posts", "form", nullable=False)
    op.drop_column("session_request_posts", "options")


def downgrade() -> None:
    op.add_column(
        "session_request_posts",
        sa.Column("options", JSONB, nullable=True),
    )
    # A questions form has no options list to go back to, and the card it stands
    # for cannot be answered by the older code either way.
    op.execute(
        "UPDATE session_request_posts SET options = CASE "
        "WHEN form ->> 'kind' = 'approval' THEN form -> 'options' "
        "ELSE '[]'::jsonb END"
    )
    op.alter_column(
        "session_request_posts",
        "options",
        nullable=False,
        server_default=sa.text("'[]'::jsonb"),
    )
    op.drop_column("session_request_posts", "form")
