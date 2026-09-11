"""media blobs

Where an attachment's bytes live once the homeserver is not there to hold
them. Nothing reads this table until the Postgres transport is the one in use,
so applying it early is free and keeps the flip to a restart.

Revision ID: a1d7f3c95b60
Revises: f4c2a8e6d193
"""

import sqlalchemy as sa
from alembic import op

revision = "a1d7f3c95b60"
down_revision = "f4c2a8e6d193"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "media_blobs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("uri", sa.Text(), nullable=False, unique=True),
        sa.Column("content_type", sa.Text(), nullable=True),
        sa.Column("filename", sa.Text(), nullable=True),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("data", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("media_blobs")
