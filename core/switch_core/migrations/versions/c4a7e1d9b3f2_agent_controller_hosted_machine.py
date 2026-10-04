"""agent controllers: bind an ec2 controller to its cloud machine

A cloud machine's supervisor enrolls the machine's agents controller with the
machine capability (proof kind `machine_secret`). The controller it gets is
of kind `ec2` and records the machine in `hosted_machine_id`; at most one
controller that is not revoked holds a machine, so enrolling again after a
reboot replaces the previous one rather than adding another.

Nothing changes for a deployment with agent management off: the column is
null everywhere.

Revision ID: c4a7e1d9b3f2
Revises: d2a7f4c9e1b8
Create Date: 2026-10-03 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4a7e1d9b3f2"
down_revision: str | Sequence[str] | None = "d2a7f4c9e1b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_controllers", sa.Column("hosted_machine_id", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_agent_controllers_hosted_machine_kind",
        "agent_controllers",
        "hosted_machine_id IS NULL OR kind = 'ec2'",
    )
    op.create_index(
        "uq_agent_controllers_hosted_machine",
        "agent_controllers",
        ["tenant_id", "hosted_machine_id"],
        unique=True,
        postgresql_where=sa.text(
            "hosted_machine_id IS NOT NULL AND revoked_at IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_agent_controllers_hosted_machine", table_name="agent_controllers")
    op.drop_constraint(
        "ck_agent_controllers_hosted_machine_kind", "agent_controllers", type_="check"
    )
    op.drop_column("agent_controllers", "hosted_machine_id")
