"""merge main's head and the hosted-agents v2 head a seventh time

`main` added one revision after `c8e4a1f7d392`: `b7e2c4a9d1f6`, which stores
every room write-private. It touches only `rooms.write_visibility`, which the
hosted-agents v2 chain does not, so this merge only joins the two heads. As
the earlier merges did, it joins them rather than re-parenting either, so a
database at `7578dcab9d39` runs `b7e2c4a9d1f6` next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 0c3b39b59766
Revises: 7578dcab9d39, b7e2c4a9d1f6
Create Date: 2026-11-13

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "0c3b39b59766"
down_revision: str | Sequence[str] | None = ("7578dcab9d39", "b7e2c4a9d1f6")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
