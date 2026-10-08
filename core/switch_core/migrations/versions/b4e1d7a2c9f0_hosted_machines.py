"""One hosted machine per user: every cloud agent of a user runs on that user's machine.

Refuses to run while any cloud agent is not removed: a launch from before this
revision owns its own VM and disk, which nothing here can move onto a machine.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "b4e1d7a2c9f0"
down_revision = "5c1e9b7d3f02"
branch_labels = None
depends_on = None


def upgrade() -> None:
    remaining = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM hosted_launches WHERE state <> 'deleted'")
    )
    if remaining:
        raise RuntimeError(
            f"hosted_machines: {remaining} cloud agent(s) are not removed. Remove them in Switch Console, then follow 'Moving to one machine per user' in deploy/hosted/README.md."
        )
    op.create_table(
        "hosted_machines",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_hosted_machines_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("slot_id", sa.Text(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("desired_state", sa.Text(), nullable=False, server_default="running"),
        sa.Column("stop_reason", sa.Text(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("instance_type", sa.Text(), nullable=True),
        sa.Column("data_volume_id", sa.Text(), nullable=True),
        sa.Column("instance_id", sa.Text(), nullable=True),
        sa.Column("retain_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("machine_capability_hash", sa.Text(), nullable=True),
        sa.Column("machine_capability_encrypted", sa.Text(), nullable=True),
        sa.Column("machine_capability_revision", sa.Integer(), nullable=True),
        sa.Column("agents_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("active_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat", JSONB(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("running_observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.CheckConstraint(
            "state IN ('queued', 'provisioning', 'ready', 'stopping', 'stopped', 'error', 'retained', 'deleting', 'deleted')",
            name="ck_hosted_machine_state",
        ),
        sa.CheckConstraint(
            "desired_state IN ('running', 'stopped', 'retained', 'deleted')",
            name="ck_hosted_machine_desired_state",
        ),
        sa.CheckConstraint(
            "stop_reason IS NULL OR stop_reason IN ('idle', 'owner')",
            name="ck_hosted_machine_stop_reason",
        ),
        sa.CheckConstraint("generation >= 1", name="ck_hosted_machine_generation"),
    )
    op.create_index(
        "uq_hosted_machine_owner",
        "hosted_machines",
        ["tenant_id", "owner_id"],
        unique=True,
        postgresql_where=sa.text("state <> 'deleted'"),
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
    op.execute("ALTER TABLE hosted_machines ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON hosted_machines FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )

    op.drop_column("hosted_launches", "sleeping")
    op.add_column("hosted_launches", sa.Column("machine_id", sa.Text(), nullable=True))
    op.add_column("hosted_launches", sa.Column("repository", sa.Text(), nullable=True))
    op.add_column(
        "hosted_launches", sa.Column("process_state", sa.Text(), nullable=True)
    )
    op.add_column(
        "hosted_launches",
        sa.Column("process_restarts", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "hosted_launches",
        sa.Column(
            "process_oom_kills", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.add_column("hosted_launches", sa.Column("process_exit", JSONB(), nullable=True))
    op.add_column(
        "hosted_launches",
        sa.Column("process_reported_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_hosted_launches_machine",
        "hosted_launches",
        "hosted_machines",
        ["tenant_id", "machine_id"],
        ["tenant_id", "id"],
    )
    op.create_check_constraint(
        "ck_hosted_launch_process_state",
        "hosted_launches",
        "process_state IS NULL OR process_state IN ('pending', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'crashed', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_hosted_launch_process_state", "hosted_launches", type_="check"
    )
    op.drop_constraint(
        "fk_hosted_launches_machine", "hosted_launches", type_="foreignkey"
    )
    for column in (
        "process_reported_at",
        "process_exit",
        "process_oom_kills",
        "process_restarts",
        "process_state",
        "repository",
        "machine_id",
    ):
        op.drop_column("hosted_launches", column)
    op.drop_table("hosted_machines")
    op.add_column(
        "hosted_launches",
        sa.Column("sleeping", sa.Boolean(), nullable=False, server_default="false"),
    )
