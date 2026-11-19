"""merge main's head and the hosted-agents v2 head an eleventh time

`main` added one revision after `e5b2c8d4f1a7`: `f3a9c1d7e2b4`,
`agent_controllers.device_hash`. It doesn't touch what the hosted-agents v2
chain changes (`users.hosted_paused_at`, `tenant_members.hosted_enabled`,
`cloud_machines` and `agent_controllers.revoked_by`), so this merge only joins
the two heads, as the earlier merges did: a database at `efd7dfbd0bb7` runs
main's one revision next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: cf7c33a238af
Revises: efd7dfbd0bb7, f3a9c1d7e2b4
Create Date: 2026-11-19

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "cf7c33a238af"
down_revision: str | Sequence[str] | None = ("efd7dfbd0bb7", "f3a9c1d7e2b4")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
