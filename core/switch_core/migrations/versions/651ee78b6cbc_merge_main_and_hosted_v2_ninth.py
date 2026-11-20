"""merge main's head and the hosted-agents v2 head a ninth time

`main` added five revisions after `c5d1e8f3a6b2`, ending at `e2c7a94f1b38`:
service connection choices, room admins, mid-turn steering, organization
Switch Trust settings, and archived workspaces. None of them touches what the
hosted-agents v2 chain changes (`users.hosted_paused_at`,
`tenant_members.hosted_enabled`, `cloud_machines` and
`agent_controllers.revoked_by`), so this merge only joins the two heads. As
the earlier merges did, it joins them rather than re-parenting either, so a
database at `97c1c62e3ca3` runs main's five next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: 651ee78b6cbc
Revises: 97c1c62e3ca3, e2c7a94f1b38
Create Date: 2026-11-16

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "651ee78b6cbc"
down_revision: str | Sequence[str] | None = ("97c1c62e3ca3", "e2c7a94f1b38")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
