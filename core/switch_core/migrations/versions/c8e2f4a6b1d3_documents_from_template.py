"""documents: mark the ones a room template made

A room template's `docs:` creates documents no agent wrote, and agents in the
room may maintain them. A NULL `created_by_agent_id` cannot carry that: the
foreign key NULLs it when the agent that wrote a document is deleted, and that
document must stay locked. So template documents say so in `from_template`.

Existing rows are left `false`. A template document made before this cannot
be told apart from one whose writer was deleted, so it stays as locked as it
was; running the template again makes documents agents can maintain.

Marked `expand_only`: a column with a default only adds to the schema, and a
release that does not know it never reads or writes it.

Revision ID: c8e2f4a6b1d3
Revises: 7105e0bea527
Create Date: 2026-11-12 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8e2f4a6b1d3"
down_revision: str | Sequence[str] | None = "7105e0bea527"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "from_template",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("documents", "from_template")
