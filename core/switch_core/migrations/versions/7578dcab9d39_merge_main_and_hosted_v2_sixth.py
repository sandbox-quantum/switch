"""merge main's head and the hosted-agents v2 head a sixth time

`main` added one revision after `861ff8767cf4`: `c8e4a1f7d392`, the prompts
that confirm a chat account link. It touches only `external_users` and
`external_user_link_requests`, which the hosted-agents v2 chain does not, so
this merge only joins the two heads. As the earlier merges did, it joins them
rather than re-parenting either, so a database at `abc98bfaa469` runs
`c8e4a1f7d392` next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 7578dcab9d39
Revises: abc98bfaa469, c8e4a1f7d392
Create Date: 2026-11-13

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "7578dcab9d39"
down_revision: str | Sequence[str] | None = ("abc98bfaa469", "c8e4a1f7d392")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
