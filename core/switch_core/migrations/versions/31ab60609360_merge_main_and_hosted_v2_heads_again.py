"""merge main's head and the hosted-agents v2 head again

`main` added ten migrations (`f2b8d6c1a4e9` to `689d7d8ff913`) after
`10f6d02ac5bc`, the main head `f3b937246dcd` already joined with the
hosted-agents v2 chain. As `f3b937246dcd` did, this joins the two heads
rather than re-parenting either, so a database already at `f3b937246dcd`
(the test server) runs main's ten next, then this. It carries no schema of
its own, and like the earlier merges it is not marked `expand_only`:
`record_expand_only` records a revision with its one parent, and a merge has
two.

Revision ID: 31ab60609360
Revises: f3b937246dcd, 689d7d8ff913
Create Date: 2026-11-09

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "31ab60609360"
down_revision: str | Sequence[str] | None = ("f3b937246dcd", "689d7d8ff913")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
