"""Persist SDK attachment integrity and session ownership."""

import sqlalchemy as sa
from alembic import op

revision: str = "a61d4c8e2907"
down_revision = "34bca049f601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sdk_sessions", sa.Column("connection_id", sa.Text(), nullable=True))
    op.create_unique_constraint(
        "uq_sdk_sessions_connection_id", "sdk_sessions", ["connection_id"]
    )
    op.add_column("media_blobs", sa.Column("sha256", sa.Text(), nullable=True))
    op.add_column("media_blobs", sa.Column("sdk_session_id", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_media_blobs_sdk_session",
        "media_blobs",
        "sdk_sessions",
        ["sdk_session_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_media_blobs_sdk_session_id", "media_blobs", ["sdk_session_id"])


def downgrade() -> None:
    op.drop_constraint("uq_sdk_sessions_connection_id", "sdk_sessions", type_="unique")
    op.drop_column("sdk_sessions", "connection_id")
    op.drop_index("ix_media_blobs_sdk_session_id", table_name="media_blobs")
    op.drop_constraint("fk_media_blobs_sdk_session", "media_blobs", type_="foreignkey")
    op.drop_column("media_blobs", "sdk_session_id")
    op.drop_column("media_blobs", "sha256")
