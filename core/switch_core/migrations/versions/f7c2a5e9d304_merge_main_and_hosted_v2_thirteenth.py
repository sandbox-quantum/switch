"""merge main's head and the hosted-agents v2 head a thirteenth time

`main` added one revision after `c18f5ebeef66`: `e223eae63078`, which drops
`server_connectors`, its row-level security policy, its `SECURITY DEFINER`
lookup and the connectors' `ownership_leases` rows. None of that is anything
the hosted-agents v2 chain changes (`users.hosted_paused_at`,
`tenant_members.hosted_enabled`, `cloud_machines`,
`agent_controllers.revoked_by` and the warm pool's tables). So this merge only
joins the two heads. As the earlier merges did, it joins them rather than
re-parenting either, so a database at `b3e9a4c71d52` runs main's one next, then
this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: f7c2a5e9d304
Revises: b3e9a4c71d52, e223eae63078
Create Date: 2026-11-24

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "f7c2a5e9d304"
down_revision: str | Sequence[str] | None = ("b3e9a4c71d52", "e223eae63078")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
