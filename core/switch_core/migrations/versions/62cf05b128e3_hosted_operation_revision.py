"""Bind queued session operations to their worker generation."""

import sqlalchemy as sa
from alembic import op

revision = "62cf05b128e3"
down_revision = "51bc94a017d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("hosted_launches", sa.Column("error_code", sa.Text(), nullable=True))
    op.execute(
        "UPDATE hosted_launches SET error_code = 'worker_needs_attention', error = 'The cloud worker could not be found. Contact your server administrator.' WHERE error = 'recorded instance lookup did not return exactly one instance'"
    )
    op.add_column(
        "hosted_operations", sa.Column("launch_revision", sa.Integer(), nullable=True)
    )
    op.execute(
        "UPDATE hosted_operations AS operation SET launch_revision = launch.revision FROM hosted_launches AS launch WHERE operation.tenant_id = launch.tenant_id AND operation.launch_id = launch.id"
    )
    op.execute(
        "UPDATE hosted_operations SET state = CASE WHEN state = 'claimed' THEN 'unknown' ELSE 'failed' END, error = 'The worker was upgraded. Inspect the session if the outcome is unknown.' WHERE state IN ('queued', 'claimed')"
    )
    op.alter_column("hosted_operations", "launch_revision", nullable=False)


def downgrade() -> None:
    op.drop_column("hosted_launches", "error_code")
    op.drop_column("hosted_operations", "launch_revision")
