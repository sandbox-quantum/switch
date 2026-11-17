"""templates.use_case: what a template is for, from a fixed list

The catalogue labels each template with what it is for (engineering, sales,
and so on). The column is nullable, and every existing template starts
without one. The check constraint holds the list as
`switch_core/template_use_cases.py` had it when this was written, copied
rather than imported for the reason every revision in this chain copies.

Expand only: a release from before this revision never reads or writes the
column, and an insert that leaves it out stores NULL, which the constraint
allows.

Revision ID: c8ceb570bbad
Revises: 368b45a3d82d
Create Date: 2026-11-16 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8ceb570bbad"
down_revision: str | None = "368b45a3d82d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

USE_CASES = (
    "engineering",
    "product",
    "support",
    "research",
    "ops",
    "personal",
    "sales",
    "marketing",
)


def upgrade() -> None:
    op.add_column("templates", sa.Column("use_case", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_templates_use_case",
        "templates",
        "use_case IN ({})".format(", ".join(f"'{u}'" for u in USE_CASES)),
    )


def downgrade() -> None:
    op.drop_constraint("ck_templates_use_case", "templates", type_="check")
    op.drop_column("templates", "use_case")
