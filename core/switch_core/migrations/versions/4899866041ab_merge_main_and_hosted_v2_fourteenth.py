"""merge main's head and the hosted-agents v2 head a fourteenth time

`main` added three revisions after `e223eae63078`: `f2c8a4d17e93` (a
`SECURITY DEFINER` function that purges a deleted workspace's
`audit_events`), `a9d3e6f1c2b7` (`cloud_machines.expedite_deletion`) and
`a25845a0e7be` (`switch_core_processes.booting`). The hosted-agents v2 chain
after the thirteenth merge, `85dfde4a8300`, adds two nullable columns to
`hosted_operator_reports` and a partial index on `server_audit_events`.
Neither side touches what the other does: main's purge function deletes only
`audit_events` rows (it reads `server_audit_events`, never writes them), and
`expedite_deletion` is a new column the v2 chain doesn't read. So this merge
only joins the two heads. As the earlier merges did, it joins them rather
than re-parenting either.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 4899866041ab
Revises: 85dfde4a8300, a25845a0e7be
Create Date: 2026-11-25

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "4899866041ab"
down_revision: str | Sequence[str] | None = ("85dfde4a8300", "a25845a0e7be")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
