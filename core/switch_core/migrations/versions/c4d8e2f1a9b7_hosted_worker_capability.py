"""Worker capability, relay sequence and fenced operation claims for hosted launches."""

import sqlalchemy as sa
from alembic import op

revision = "c4d8e2f1a9b7"
down_revision = "33e037ee949f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hosted_launches", sa.Column("worker_capability_hash", sa.Text(), nullable=True)
    )
    op.add_column(
        "hosted_launches",
        sa.Column("worker_capability_encrypted", sa.Text(), nullable=True),
    )
    op.add_column(
        "hosted_launches",
        sa.Column("worker_capability_revision", sa.Integer(), nullable=True),
    )
    op.add_column(
        "hosted_launches",
        sa.Column("relay_seq", sa.BigInteger(), server_default="0", nullable=False),
    )
    op.add_column(
        "hosted_operations", sa.Column("claimed_by", sa.Text(), nullable=True)
    )
    op.add_column(
        "hosted_operations", sa.Column("claimed_boot_id", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("hosted_operations", "claimed_boot_id")
    op.drop_column("hosted_operations", "claimed_by")
    op.drop_column("hosted_launches", "relay_seq")
    op.drop_column("hosted_launches", "worker_capability_revision")
    op.drop_column("hosted_launches", "worker_capability_encrypted")
    op.drop_column("hosted_launches", "worker_capability_hash")
