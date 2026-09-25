"""Track idle auto-stop on hosted launches."""

import sqlalchemy as sa
from alembic import op

revision = "48ab0298a34b"
down_revision = "a472be90d1f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosted_launches",
        sa.Column("sleeping", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "hosted_launches",
        sa.Column(
            "active_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_column("hosted_launches", "active_at")
    op.drop_column("hosted_launches", "sleeping")
