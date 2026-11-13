"""merge main's head and the hosted-agents v2 head a fifth time

`main` added three revisions after `c8e2f4a6b1d3`, ending at `861ff8767cf4`:
template run records, hidden official templates, and when telemetry was
switched on and each cloud machine was first ready. None of them touches what
the hosted-agents v2 chain changes, so this merge only joins the two heads. As
the earlier merges did, it joins them rather than re-parenting either, so a
database at `31f9c357ce29` runs main's revisions next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: abc98bfaa469
Revises: 31f9c357ce29, 861ff8767cf4
Create Date: 2026-11-13

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "abc98bfaa469"
down_revision: str | Sequence[str] | None = ("31f9c357ce29", "861ff8767cf4")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
