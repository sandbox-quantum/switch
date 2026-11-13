"""merge main's head and the hosted-agents v2 head a third time

`main` added `95b5d17f4519` (an index on `tenant_members` by user) after
`689d7d8ff913`, the main head `31ab60609360` already joined with the
hosted-agents v2 chain. As `31ab60609360` did, this joins the two heads
rather than re-parenting either, so a database already at `31ab60609360`
runs main's `95b5d17f4519` next, then this. It carries no schema of its own,
and like the earlier merges it is not marked `expand_only`:
`record_expand_only` records a revision with its one parent, and a merge has
two.

Revision ID: 9b1630d39363
Revises: 31ab60609360, 95b5d17f4519
Create Date: 2026-11-11

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "9b1630d39363"
down_revision: str | Sequence[str] | None = ("31ab60609360", "95b5d17f4519")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
