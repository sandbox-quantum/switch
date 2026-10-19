"""claim a room message before posting it to a platform

`bridge_message_map.external_post_id` may be null: a bridge relaying a room
message out writes the row first, as a claim, and fills the platform's post id
in once the post is made. A second switch-core process handling the same room
message finds the claim and does not post it again, which is what keeps a
bridge's hand-over between processes from posting a message twice. Existing
rows all carry a post id and are unchanged.

Revision ID: 1feaa7700723
Revises: 340ead685ad6
Create Date: 2026-10-14 13:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "1feaa7700723"
down_revision: str | None = "340ead685ad6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "bridge_message_map", "external_post_id", existing_type=sa.Text(), nullable=True
    )


def downgrade() -> None:
    # Claims never turned into posts have nothing to keep.
    op.execute("DELETE FROM bridge_message_map WHERE external_post_id IS NULL")
    op.alter_column(
        "bridge_message_map",
        "external_post_id",
        existing_type=sa.Text(),
        nullable=False,
    )
