"""merge main's head and the hosted-agents v2 head a tenth time

`main` added seven revisions after `e2c7a94f1b38`, ending at `e5b2c8d4f1a7`:
auth attempts and revoked sessions, browser handoffs, further bridge posts,
a merge of those two heads, the templates' use case, template runs' `run_by`,
and retiring the bundled Mattermost bridge. None of them touches what the
hosted-agents v2 chain changes (`users.hosted_paused_at`,
`tenant_members.hosted_enabled`, `cloud_machines` and
`agent_controllers.revoked_by`), so this merge only joins the two heads. As
the earlier merges did, it joins them rather than re-parenting either, so a
database at `651ee78b6cbc` runs main's seven next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two.

Revision ID: efd7dfbd0bb7
Revises: 651ee78b6cbc, e5b2c8d4f1a7
Create Date: 2026-11-17

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "efd7dfbd0bb7"
down_revision: str | Sequence[str] | None = ("651ee78b6cbc", "e5b2c8d4f1a7")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
