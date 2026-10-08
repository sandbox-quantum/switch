"""Resume cloud identity cleanup after a partial deletion."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "84eb27d340a5"
down_revision = "73da16c239f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosted_launches",
        sa.Column("deletion_cleanup", postgresql.JSONB(), nullable=True),
    )
    op.execute(
        "UPDATE hosted_launches SET error = 'The cloud worker needs attention. Contact your server administrator.' WHERE error_code = 'worker_needs_attention'"
    )


def downgrade() -> None:
    op.drop_column("hosted_launches", "deletion_cleanup")
