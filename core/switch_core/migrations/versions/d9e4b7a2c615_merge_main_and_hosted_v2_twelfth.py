"""merge main's head and the hosted-agents v2 head a twelfth time

`main` added three revisions after `f3a9c1d7e2b4`, ending at `c18f5ebeef66`:
frozen rooms (`a3f9c1e7d205`), suspended accounts and agents
(`a3f9c2d71e08`, `users.suspended_at` and friends) and the decision
settings' new backends (`c18f5ebeef66`). None of them touches what the
hosted-agents v2 chain changes (`users.hosted_paused_at`,
`tenant_members.hosted_enabled`, `cloud_machines` and
`agent_controllers.revoked_by`): `users` gains different columns on each
side. So this merge only joins the two heads. As the earlier merges did, it
joins them rather than re-parenting either, so a database at `850587725db3`
runs main's three next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: d9e4b7a2c615
Revises: 850587725db3, c18f5ebeef66
Create Date: 2026-11-23

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "d9e4b7a2c615"
down_revision: str | Sequence[str] | None = ("850587725db3", "c18f5ebeef66")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
