"""template_run_records.run_by: whose run a count was, to tell a repeat report

Switch Console reports each run of a template once it has succeeded, and the
report is only a report: nothing checks that a run happened. A person's
report is now believed at most once per template in a window, and a run the
server made itself is counted for that person too, so their report of the
same run is not counted again. Both need to know whose run a row was.

The column is nullable: every existing row, and every agent's run, names
nobody. It is cleared when the account it names is deleted.

Expand only: a release from before this revision never reads the column, and
an insert that leaves it out stores NULL.

Revision ID: 8e1c5e9b7d77
Revises: c8ceb570bbad
Create Date: 2026-11-16 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8e1c5e9b7d77"
down_revision: str | None = "c8ceb570bbad"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column("template_run_records", sa.Column("run_by", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_template_run_records_run_by",
        "template_run_records",
        "users",
        ["run_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_template_run_records_run_by", "template_run_records", type_="foreignkey"
    )
    op.drop_column("template_run_records", "run_by")
