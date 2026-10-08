"""Drop the feature_flags table: flags are set when the server is deployed.

Revision ID: 9c4e7a1f2b38
Revises: eb24eafa59a0
Create Date: 2026-10-07 00:00:00.000000

Flags used to be rows anyone holding an agent token could flip. They now come
from `FEATURE_FLAGS_ENABLED` alone, so the table goes. A flag that was on is
logged, so an operator knows what to put in that setting to keep it on.
Downgrade recreates the table empty: every flag reads as off until set again.
"""

import logging

import sqlalchemy as sa
from alembic import op

logger = logging.getLogger("alembic.runtime.migration")

revision = "9c4e7a1f2b38"
down_revision = "eb24eafa59a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    enabled = [
        row.key
        for row in op.get_bind().execute(
            sa.text("SELECT key FROM feature_flags WHERE enabled ORDER BY key")
        )
    ]
    if enabled:
        logger.warning(
            "Feature flags are now set at deploy time. These were on and are "
            "off from now on unless listed in FEATURE_FLAGS_ENABLED: %s",
            ", ".join(enabled),
        )
    op.drop_table("feature_flags")


def downgrade() -> None:
    op.create_table(
        "feature_flags",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key"),
    )
