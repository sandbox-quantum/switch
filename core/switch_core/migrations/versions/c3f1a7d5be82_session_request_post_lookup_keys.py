"""make a card's lookups unique the way they are read

Both reads that resolve a typed answer expect one row or none. The handle is
matched without regard to case while the constraint was on the raw value, so
"R42" beside "r42" in one channel made the lookup raise; nothing at all said a
posted card stands for one request. Either exception escapes into the message
relay, where the cost is not a refused answer but a message the room never
sees.

Revision ID: c3f1a7d5be82
Revises: b6d20e5a91c4
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3f1a7d5be82"
down_revision: str | Sequence[str] | None = "b6d20e5a91c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "uq_session_request_posts_handle", "session_request_posts", type_="unique"
    )
    op.create_index(
        "uq_session_request_posts_handle",
        "session_request_posts",
        ["bridge_id", "external_channel_id", sa.text("lower(handle)")],
        unique=True,
    )
    op.create_unique_constraint(
        "uq_session_request_posts_post",
        "session_request_posts",
        ["bridge_id", "external_post_id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_session_request_posts_post", "session_request_posts", type_="unique"
    )
    op.drop_index("uq_session_request_posts_handle", "session_request_posts")
    op.create_unique_constraint(
        "uq_session_request_posts_handle",
        "session_request_posts",
        ["bridge_id", "external_channel_id", "handle"],
    )
