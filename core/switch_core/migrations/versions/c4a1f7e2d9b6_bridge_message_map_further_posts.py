"""bridge message map: the further posts of a message the platform split

Telegram caps a message at 4,096 characters, so a longer agent answer goes out
as several messages, and only the first was recorded. A reply to any later
part found nothing and lost its conversation. `further_post_ids` holds the
other parts, with a GIN index so an inbound reply is looked up by any of them.

Expand only: a release from before this revision neither reads nor writes the
column, and a message it posts is recorded by its first part, as before.

Revision ID: c4a1f7e2d9b6
Revises: e2c7a94f1b38
Create Date: 2026-11-16 23:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4a1f7e2d9b6"
down_revision: str | None = "e2c7a94f1b38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "bridge_message_map",
        sa.Column("further_post_ids", postgresql.ARRAY(sa.Text()), nullable=True),
    )
    op.create_index(
        "ix_bridge_message_map_further_post_ids",
        "bridge_message_map",
        ["further_post_ids"],
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_index(
        "ix_bridge_message_map_further_post_ids", table_name="bridge_message_map"
    )
    op.drop_column("bridge_message_map", "further_post_ids")
