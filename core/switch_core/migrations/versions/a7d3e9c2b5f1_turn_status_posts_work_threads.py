"""turn status posts: a turn's work message and its earlier streams

On Slack, a room with `!work-threads on` draws a turn asked at the channel root
in a thread under a message of the agent's own (`work_message_ref`), and Slack
closes a stream ten minutes after it opens, so a long turn is drawn across
several streams in that thread: `earlier_post_ids` holds every one but the
current, which stays `external_post_id`. Both are kept so the turn's ending can
find them after a restart, to attach the plan to the answer and remove them.
`work_finished_at` says that ending has run, and `folded_into` is set when the
work thread was removed (to the answer the plan went under, or to the work
message for a turn with nothing to show), so nothing draws into messages that
are gone. `stopped_by` names whoever pressed Stop on the turn, which its
ending says.

Expand only: a release from before this revision neither reads nor writes the
columns, and draws every turn in the asker's thread as before.

Revision ID: a7d3e9c2b5f1
Revises: f3a9c1d7e2b4
Create Date: 2026-11-19 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a7d3e9c2b5f1"
down_revision: str | None = "f3a9c1d7e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "turn_status_posts",
        sa.Column("work_message_ref", sa.Text(), nullable=True),
    )
    op.add_column(
        "turn_status_posts",
        sa.Column("earlier_post_ids", postgresql.ARRAY(sa.Text()), nullable=True),
    )
    op.add_column(
        "turn_status_posts",
        sa.Column("work_finished_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "turn_status_posts",
        sa.Column("folded_into", sa.Text(), nullable=True),
    )
    op.add_column(
        "turn_status_posts",
        sa.Column("stopped_by", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("turn_status_posts", "stopped_by")
    op.drop_column("turn_status_posts", "folded_into")
    op.drop_column("turn_status_posts", "work_finished_at")
    op.drop_column("turn_status_posts", "earlier_post_ids")
    op.drop_column("turn_status_posts", "work_message_ref")
