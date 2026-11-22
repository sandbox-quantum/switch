"""A server administrator can stop a cloud machine so its owner cannot start it again.

Revision ID: e3b8d1f6a2c4
Revises: a4c7e2d9b813
"""

from alembic import op

revision = "e3b8d1f6a2c4"
down_revision = "a4c7e2d9b813"
branch_labels = None
depends_on = None
expand_only: bool = True


def upgrade() -> None:
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint(
        "ck_cloud_machine_stop_reason",
        "cloud_machines",
        "stop_reason IS NULL OR stop_reason IN ('idle', 'owner', 'admin')",
    )


def downgrade() -> None:
    # An administrator's stop becomes the owner's: a stopped machine stays
    # stopped, but its owner can start it again.
    op.execute(
        "UPDATE cloud_machines SET stop_reason = CASE WHEN desired_state = 'stopped' "
        "THEN 'owner' END WHERE stop_reason = 'admin'"
    )
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint(
        "ck_cloud_machine_stop_reason",
        "cloud_machines",
        "stop_reason IS NULL OR stop_reason IN ('idle', 'owner')",
    )
