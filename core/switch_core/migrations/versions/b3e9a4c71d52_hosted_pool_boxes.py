"""hosted pool boxes: the hosted agents v2 warm pool

`hosted_pool_boxes`, a global table (no tenant, no policy, as
`cloud_machines`): boxes made before anyone asked, each owned by no person
until a claim turns it into that person's `cloud_machines` row with the same
id. State moves forward only: `requested`, `waiting`, `claimed`, `retiring`,
`gone`. And `hosted_operator_reports`, one global row: the box operator's
last template revision and capabilities, from its polls.

Additive: a new table nothing older reads, so an older Core serves on as
before. The downgrade drops it; any pool boxes it named are then just
namespaces the reaper no longer hears about, which the operator's own
clean-up handles.

Revision ID: b3e9a4c71d52
Revises: e5c1a8f3b294
Create Date: 2026-11-24 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b3e9a4c71d52"
down_revision: str | Sequence[str] | None = "e5c1a8f3b294"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "hosted_pool_boxes",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("template_revision", sa.Text(), nullable=True),
        sa.Column("namespace", sa.Text(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("retire_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "state IN ('requested', 'waiting', 'claimed', 'retiring', 'gone')",
            name="ck_hosted_pool_box_state",
        ),
        sa.CheckConstraint(
            "retire_reason IS NULL OR retire_reason IN "
            "('image', 'age', 'size', 'make_failed', 'failed_before_owner')",
            name="ck_hosted_pool_box_retire_reason",
        ),
    )
    op.create_index(
        "ix_hosted_pool_boxes_state", "hosted_pool_boxes", ["state", "requested_at"]
    )
    op.create_table(
        "hosted_operator_reports",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("template_revision", sa.Text(), nullable=True),
        sa.Column("capabilities", postgresql.JSONB(), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("hosted_operator_reports")
    op.drop_index("ix_hosted_pool_boxes_state", table_name="hosted_pool_boxes")
    op.drop_table("hosted_pool_boxes")
