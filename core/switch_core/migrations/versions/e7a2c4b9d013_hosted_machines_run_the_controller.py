"""hosted machines: run the agents controller, enrolled with a one-time code

`hosted_machines.runtime` says what a machine runs: `worker` (every existing
machine, unchanged) or `controller`, the agents controller, enrolled with a
one-time code Core mints for the machine. `controller_id` is the controller
it enrolled as; `enrollment_code_encrypted`/`_revision` keep the code handed
over for a revision, so a retried prepare hands over the same one.
`agent_controller_enrollment_codes.hosted_machine_id` names the machine a
code was minted for.

Revision ID: e7a2c4b9d013
Revises: d41c7a9e2b58
Create Date: 2026-10-08 20:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a2c4b9d013"
down_revision: str | None = "d41c7a9e2b58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_machines",
        sa.Column("runtime", sa.Text(), server_default="worker", nullable=False),
    )
    op.create_check_constraint(
        "ck_hosted_machine_runtime",
        "hosted_machines",
        "runtime IN ('worker', 'controller')",
    )
    op.add_column("hosted_machines", sa.Column("controller_id", sa.Text()))
    op.create_foreign_key(
        "fk_hosted_machines_controller",
        "hosted_machines",
        "agent_controllers",
        ["tenant_id", "controller_id"],
        ["tenant_id", "id"],
        ondelete="SET NULL (controller_id)",
    )
    op.add_column("hosted_machines", sa.Column("enrollment_code_encrypted", sa.Text()))
    op.add_column(
        "hosted_machines", sa.Column("enrollment_code_revision", sa.Integer())
    )
    op.add_column(
        "agent_controller_enrollment_codes",
        sa.Column("hosted_machine_id", sa.Text(), nullable=True),
    )
    op.create_foreign_key(
        "fk_agent_controller_enrollment_codes_hosted_machine",
        "agent_controller_enrollment_codes",
        "hosted_machines",
        ["tenant_id", "hosted_machine_id"],
        ["tenant_id", "id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_agent_controller_enrollment_codes_hosted_machine",
        "agent_controller_enrollment_codes",
        type_="foreignkey",
    )
    op.drop_column("agent_controller_enrollment_codes", "hosted_machine_id")
    op.drop_column("hosted_machines", "enrollment_code_revision")
    op.drop_column("hosted_machines", "enrollment_code_encrypted")
    op.drop_constraint(
        "fk_hosted_machines_controller", "hosted_machines", type_="foreignkey"
    )
    op.drop_column("hosted_machines", "controller_id")
    op.drop_constraint("ck_hosted_machine_runtime", "hosted_machines", type_="check")
    op.drop_column("hosted_machines", "runtime")
