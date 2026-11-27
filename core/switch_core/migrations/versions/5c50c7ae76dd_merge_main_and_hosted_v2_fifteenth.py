"""merge main's head and the hosted-agents v2 head a fifteenth time

`main` added one revision after `a25845a0e7be`: `df57881f482a`, nullable
`users` columns for the dashboard's team survey answers and license
acceptance. Nothing in the hosted-agents v2 chain reads or writes those
columns, and main's revision touches none of v2's (`users.hosted_paused_at`,
`tenant_members.hosted_enabled`, `cloud_machines`, the warm pool's tables
and the operator reports). So this merge only joins the two heads. As the
earlier merges did, it joins them rather than re-parenting either.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 5c50c7ae76dd
Revises: 4899866041ab, df57881f482a
Create Date: 2026-11-27

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "5c50c7ae76dd"
down_revision: str | Sequence[str] | None = ("4899866041ab", "df57881f482a")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
