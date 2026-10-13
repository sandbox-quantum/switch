"""one cloud machine per user: `cloud_machines` and `machine_workspaces`

A user's Switch cloud machine was a row of one workspace. It becomes the
user's, whichever workspaces it serves: `cloud_machines` is global, as the
person is, and holds the VM's lifecycle; `machine_workspaces` holds, per
workspace and under row-level security, the agents controller the machine
runs there and the code it enrolls with. `tenants_of_cloud_machine` says which
workspaces a machine serves, for the cloud controller, which acts for none.

Each existing machine keeps its id, and its workspace row takes the same id,
so its controller and its enrollment carry over. Refuses to run when one user
has live machines in two workspaces: nothing here could merge them.

The lookup's DDL is a frozen copy of `switch_core/db/tenant_lookup.py`'s, as
every revision in this chain copies rather than imports.

Revision ID: b6e1c9d4a7f2
Revises: a8c3e5f1d27b
Create Date: 2026-10-09 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "b6e1c9d4a7f2"
down_revision: str | None = "a8c3e5f1d27b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANTS_OF_CLOUD_MACHINE = f"""CREATE OR REPLACE FUNCTION tenants_of_cloud_machine(p_machine_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM machine_workspaces WHERE machine_id = p_machine_id ORDER BY created_at, tenant_id$$"""

DROP_TENANTS_OF_CLOUD_MACHINE = "DROP FUNCTION IF EXISTS tenants_of_cloud_machine(text)"

STATES = "state IN ('queued', 'provisioning', 'ready', 'stopping', 'stopped', 'error', 'retained', 'deleting', 'deleted')"
DESIRED_STATES = "desired_state IN ('running', 'stopped', 'retained', 'deleted')"
STOP_REASONS = "stop_reason IS NULL OR stop_reason IN ('idle', 'owner')"


def _timestamps() -> list[sa.Column]:
    return [
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
    ]


def upgrade() -> None:
    connection = op.get_bind()
    shared = connection.scalar(
        sa.text(
            "SELECT count(*) FROM (SELECT owner_id FROM hosted_machines "
            "WHERE state <> 'deleted' GROUP BY owner_id HAVING count(*) > 1) AS owners"
        )
    )
    if shared:
        raise RuntimeError(
            f"one cloud machine per user: {shared} user(s) have cloud machines that "
            "are not deleted in more than one workspace. Remove all but one of each "
            "user's cloud machines in Switch Console, then upgrade again."
        )

    op.create_table(
        "cloud_machines",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("desired_state", sa.Text(), nullable=False, server_default="running"),
        sa.Column("stop_reason", sa.Text(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("instance_type", sa.Text(), nullable=True),
        sa.Column("data_volume_id", sa.Text(), nullable=True),
        sa.Column("instance_id", sa.Text(), nullable=True),
        sa.Column("retain_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat", JSONB(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("running_observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(STATES, name="ck_cloud_machine_state"),
        sa.CheckConstraint(DESIRED_STATES, name="ck_cloud_machine_desired_state"),
        sa.CheckConstraint(STOP_REASONS, name="ck_cloud_machine_stop_reason"),
    )
    op.create_index(
        "uq_cloud_machine_owner",
        "cloud_machines",
        ["owner_id"],
        unique=True,
        postgresql_where=sa.text("state <> 'deleted'"),
    )
    op.create_table(
        "machine_workspaces",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_machine_workspaces_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "machine_id", sa.Text(), sa.ForeignKey("cloud_machines.id"), nullable=False
        ),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("controller_id", sa.Text(), nullable=True),
        sa.Column("enrollment_code_encrypted", sa.Text(), nullable=True),
        sa.Column("enrollment_code_revision", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_machine_workspaces_controller",
            ondelete="SET NULL (controller_id)",
        ),
        sa.UniqueConstraint(
            "tenant_id", "machine_id", name="uq_machine_workspaces_machine"
        ),
    )
    op.create_index(
        "ix_machine_workspaces_machine_id", "machine_workspaces", ["machine_id"]
    )
    op.execute("ALTER TABLE machine_workspaces ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON machine_workspaces FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )

    op.execute(
        """
        INSERT INTO cloud_machines (
            id, owner_id, state, desired_state, stop_reason, revision, instance_type,
            data_volume_id, instance_id, retain_until, active_at, heartbeat,
            heartbeat_at, running_observed_at, error, error_code, created_at, updated_at
        )
        SELECT id, owner_id, state, desired_state, stop_reason, revision, instance_type,
            data_volume_id, instance_id, retain_until, active_at,
            CASE WHEN heartbeat IS NULL THEN NULL ELSE jsonb_build_object(
                'disk', heartbeat -> 'disk',
                'memory', heartbeat -> 'memory',
                'controllers', jsonb_build_object(id, jsonb_build_object(
                    'at', to_jsonb(heartbeat_at),
                    'sessions_running', heartbeat -> 'sessions_running'
                ))
            ) END,
            heartbeat_at, running_observed_at, error, error_code, created_at, updated_at
        FROM hosted_machines
        """
    )
    op.execute(
        """
        INSERT INTO machine_workspaces (
            tenant_id, id, machine_id, owner_id, controller_id,
            enrollment_code_encrypted, enrollment_code_revision, created_at
        )
        SELECT tenant_id, id, id, owner_id, controller_id,
            enrollment_code_encrypted, enrollment_code_revision, created_at
        FROM hosted_machines
        """
    )

    op.drop_constraint(
        "fk_agent_controller_enrollment_codes_hosted_machine",
        "agent_controller_enrollment_codes",
        type_="foreignkey",
    )
    op.alter_column(
        "agent_controller_enrollment_codes",
        "hosted_machine_id",
        new_column_name="machine_workspace_id",
    )
    op.create_foreign_key(
        "fk_agent_controller_enrollment_codes_machine_workspace",
        "agent_controller_enrollment_codes",
        "machine_workspaces",
        ["tenant_id", "machine_workspace_id"],
        ["tenant_id", "id"],
    )
    op.drop_table("hosted_machines")
    op.execute(CREATE_TENANTS_OF_CLOUD_MACHINE)


def downgrade() -> None:
    connection = op.get_bind()
    shared = connection.scalar(
        sa.text(
            "SELECT count(*) FROM (SELECT machine_id FROM machine_workspaces "
            "GROUP BY machine_id HAVING count(*) > 1) AS machines"
        )
    )
    if shared:
        raise RuntimeError(
            f"one cloud machine per user cannot be undone: {shared} cloud machine(s) "
            "serve more than one workspace."
        )
    op.execute(DROP_TENANTS_OF_CLOUD_MACHINE)
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
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("desired_state", sa.Text(), nullable=False, server_default="running"),
        sa.Column("stop_reason", sa.Text(), nullable=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("instance_type", sa.Text(), nullable=True),
        sa.Column("data_volume_id", sa.Text(), nullable=True),
        sa.Column("instance_id", sa.Text(), nullable=True),
        sa.Column("retain_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("controller_id", sa.Text(), nullable=True),
        sa.Column("enrollment_code_encrypted", sa.Text(), nullable=True),
        sa.Column("enrollment_code_revision", sa.Integer(), nullable=True),
        sa.Column("active_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat", JSONB(), nullable=True),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("running_observed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.CheckConstraint(STATES, name="ck_hosted_machine_state"),
        sa.CheckConstraint(DESIRED_STATES, name="ck_hosted_machine_desired_state"),
        sa.CheckConstraint(STOP_REASONS, name="ck_hosted_machine_stop_reason"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_hosted_machines_controller",
            ondelete="SET NULL (controller_id)",
        ),
    )
    op.create_index(
        "uq_hosted_machine_owner",
        "hosted_machines",
        ["tenant_id", "owner_id"],
        unique=True,
        postgresql_where=sa.text("state <> 'deleted'"),
    )
    op.execute("ALTER TABLE hosted_machines ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON hosted_machines FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )
    op.execute(
        """
        INSERT INTO hosted_machines (
            tenant_id, id, owner_id, state, desired_state, stop_reason, revision,
            instance_type, data_volume_id, instance_id, retain_until, controller_id,
            enrollment_code_encrypted, enrollment_code_revision, active_at, heartbeat,
            heartbeat_at, running_observed_at, error, error_code, created_at, updated_at
        )
        SELECT w.tenant_id, w.id, m.owner_id, m.state, m.desired_state, m.stop_reason,
            m.revision, m.instance_type, m.data_volume_id, m.instance_id,
            m.retain_until, w.controller_id, w.enrollment_code_encrypted,
            w.enrollment_code_revision, m.active_at,
            CASE WHEN m.heartbeat IS NULL THEN NULL ELSE jsonb_build_object(
                'disk', m.heartbeat -> 'disk',
                'memory', m.heartbeat -> 'memory',
                'sessions_running', m.heartbeat -> 'controllers' -> w.id -> 'sessions_running'
            ) END,
            m.heartbeat_at, m.running_observed_at, m.error, m.error_code,
            m.created_at, m.updated_at
        FROM machine_workspaces AS w JOIN cloud_machines AS m ON m.id = w.machine_id
        """
    )
    op.drop_constraint(
        "fk_agent_controller_enrollment_codes_machine_workspace",
        "agent_controller_enrollment_codes",
        type_="foreignkey",
    )
    op.alter_column(
        "agent_controller_enrollment_codes",
        "machine_workspace_id",
        new_column_name="hosted_machine_id",
    )
    op.execute(
        "UPDATE agent_controller_enrollment_codes AS c SET hosted_machine_id = NULL "
        "WHERE hosted_machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM hosted_machines AS h "
        "WHERE h.tenant_id = c.tenant_id AND h.id = c.hosted_machine_id)"
    )
    op.create_foreign_key(
        "fk_agent_controller_enrollment_codes_hosted_machine",
        "agent_controller_enrollment_codes",
        "hosted_machines",
        ["tenant_id", "hosted_machine_id"],
        ["tenant_id", "id"],
    )
    op.drop_table("machine_workspaces")
    op.drop_table("cloud_machines")
