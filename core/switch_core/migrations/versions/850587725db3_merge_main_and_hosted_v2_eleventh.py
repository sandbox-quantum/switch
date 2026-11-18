"""merge main's head and the hosted-agents v2 head an eleventh time

`main` added one revision after `e5b2c8d4f1a7`: `f3a9c1d7e2b4`, the
nullable `agent_controllers.device_hash` and its partial index. The
hosted-agents v2 chain also changes `agent_controllers`, but only its own
column (`revoked_by`), so the two don't touch: this merge only joins the two
heads. As the earlier merges did, it joins them rather than re-parenting
either, so a database at `efd7dfbd0bb7` runs main's one revision next, then
this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 850587725db3
Revises: efd7dfbd0bb7, f3a9c1d7e2b4
Create Date: 2026-11-18

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "850587725db3"
down_revision: str | Sequence[str] | None = ("efd7dfbd0bb7", "f3a9c1d7e2b4")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
