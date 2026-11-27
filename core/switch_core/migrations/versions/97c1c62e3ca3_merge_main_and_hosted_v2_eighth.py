"""merge main's head and the hosted-agents v2 head an eighth time

`main` added one revision after `b7e2c4a9d1f6`: `c5d1e8f3a6b2`, which gives
service grant revisions a sequence of their own. It touches only
`service_grants` and that sequence, which the hosted-agents v2 chain does not,
so this merge only joins the two heads. As the earlier merges did, it joins
them rather than re-parenting either, so a database at `0c3b39b59766` runs
`c5d1e8f3a6b2` next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 97c1c62e3ca3
Revises: 0c3b39b59766, c5d1e8f3a6b2
Create Date: 2026-11-13

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "97c1c62e3ca3"
down_revision: str | Sequence[str] | None = ("0c3b39b59766", "c5d1e8f3a6b2")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
