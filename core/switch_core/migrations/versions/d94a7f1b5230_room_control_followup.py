"""Persist room control follow-ups until their command succeeds."""

import sqlalchemy as sa
from alembic import op

revision = "d94a7f1b5230"
down_revision = "c83f6e0a4129"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sdk_session_commands",
        sa.Column("room_control_followup", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sdk_session_commands", "room_control_followup")
