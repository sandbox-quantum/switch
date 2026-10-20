"""cloud machines without slots: drop the slot and generation of a machine

A cloud machine no longer borrows one of a fixed pool of operator slots: the
machine id alone names it and its resources, and capacity is
`HOSTED_LAUNCH_CAPACITY`.

Revision ID: a8c3e5f1d27b
Revises: f5d2b8e6c3a1
Create Date: 2026-10-09 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a8c3e5f1d27b"
down_revision: str | None = "f5d2b8e6c3a1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("uq_hosted_machine_generation", table_name="hosted_machines")
    op.drop_index("uq_hosted_machine_slot", table_name="hosted_machines")
    op.drop_constraint("ck_hosted_machine_generation", "hosted_machines", type_="check")
    op.drop_column("hosted_machines", "generation")
    op.drop_column("hosted_machines", "slot_id")


def downgrade() -> None:
    op.add_column("hosted_machines", sa.Column("slot_id", sa.Text(), nullable=True))
    op.add_column(
        "hosted_machines", sa.Column("generation", sa.Integer(), nullable=True)
    )
    # Every machine gets a slot of its own: its id.
    op.execute("UPDATE hosted_machines SET slot_id = id, generation = 1")
    op.alter_column("hosted_machines", "slot_id", nullable=False)
    op.alter_column("hosted_machines", "generation", nullable=False)
    op.create_check_constraint(
        "ck_hosted_machine_generation", "hosted_machines", "generation >= 1"
    )
    op.create_index(
        "uq_hosted_machine_slot",
        "hosted_machines",
        ["tenant_id", "slot_id"],
        unique=True,
        postgresql_where=sa.text("state <> 'deleted'"),
    )
    op.create_index(
        "uq_hosted_machine_generation",
        "hosted_machines",
        ["tenant_id", "slot_id", "generation"],
        unique=True,
    )
