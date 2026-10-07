"""remove the hosted worker runtime

A cloud agent is a managed agent on its owner's cloud machine's agent
controller; nothing runs a per-agent hosted worker any more. Its launches, and
everything keyed by a launch, go: GitHub tokens issued to workers, worker
operations, the cutover bookkeeping, provider verification workers, and the
wake mailbox rows a worker would have admitted. Agents lose the
`hosted_launch_id` metadata key that tied them to a launch. A cloud machine's
runtime is the controller only, and the machine capability a worker presented
goes with the worker.

A machine still on the worker runtime that is not deleted refuses the
upgrade: its VM runs the worker, and only tearing it down is safe. A deleted
one is history and is marked a controller machine.

Downgrade recreates the schema with no data.

Revision ID: 79aad3bd6dde
Revises: b6d1f0a3c925
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "79aad3bd6dde"
down_revision: str | Sequence[str] | None = "b6d1f0a3c925"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON {table} FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def upgrade() -> None:
    live_workers = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT tenant_id, id FROM hosted_machines "
                "WHERE runtime <> 'controller' AND state <> 'deleted' "
                "ORDER BY tenant_id, id"
            )
        )
        .all()
    )
    if live_workers:
        raise RuntimeError(
            "Refusing to remove the hosted worker runtime while cloud machines "
            "still run it: "
            + ", ".join(f"{row.tenant_id}/{row.id}" for row in live_workers)
            + ". Delete those machines first."
        )
    op.execute(
        "UPDATE agents SET metadata = metadata - 'hosted_launch_id' "
        "WHERE metadata ? 'hosted_launch_id'"
    )
    op.execute("DELETE FROM hosted_wake_mailbox WHERE launch_id IS NOT NULL")

    op.drop_table("github_issued_tokens")
    op.drop_table("hosted_operations")
    op.drop_table("hosted_cutover_items")
    op.drop_table("hosted_cutover_volumes")
    op.drop_table("provider_verifications")
    op.drop_constraint(
        "hosted_wake_mailbox_tenant_id_launch_id_fkey",
        "hosted_wake_mailbox",
        type_="foreignkey",
    )
    op.drop_column("hosted_wake_mailbox", "launch_id")
    op.drop_table("hosted_launches")

    op.drop_column("hosted_machines", "machine_capability_hash")
    op.drop_column("hosted_machines", "machine_capability_encrypted")
    op.drop_column("hosted_machines", "machine_capability_revision")
    op.execute("UPDATE hosted_machines SET runtime = 'controller'")
    op.drop_constraint("ck_hosted_machine_runtime", "hosted_machines", type_="check")
    op.create_check_constraint(
        "ck_hosted_machine_runtime", "hosted_machines", "runtime IN ('controller')"
    )
    op.alter_column("hosted_machines", "runtime", server_default="controller")


def downgrade() -> None:
    op.alter_column("hosted_machines", "runtime", server_default="worker")
    op.drop_constraint("ck_hosted_machine_runtime", "hosted_machines", type_="check")
    op.create_check_constraint(
        "ck_hosted_machine_runtime",
        "hosted_machines",
        "runtime IN ('worker', 'controller')",
    )
    op.add_column("hosted_machines", sa.Column("machine_capability_hash", sa.Text()))
    op.add_column(
        "hosted_machines", sa.Column("machine_capability_encrypted", sa.Text())
    )
    op.add_column(
        "hosted_machines", sa.Column("machine_capability_revision", sa.Integer())
    )

    op.create_table(
        "hosted_launches",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("spec", JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("agent_id", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("desired_state", sa.Text(), nullable=False, server_default="running"),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "active_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("error_code", sa.Text()),
        sa.Column("deletion_cleanup", JSONB()),
        sa.Column("worker_capability_hash", sa.Text()),
        sa.Column("worker_capability_encrypted", sa.Text()),
        sa.Column("worker_capability_revision", sa.Integer()),
        sa.Column("relay_seq", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("machine_id", sa.Text()),
        sa.Column("repository", sa.Text()),
        sa.Column("process_state", sa.Text()),
        sa.Column("process_restarts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "process_oom_kills", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("process_exit", JSONB()),
        sa.Column("process_reported_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.UniqueConstraint("tenant_id", "name", name="uq_hosted_launch_name"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_hosted_launches_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "machine_id"],
            ["hosted_machines.tenant_id", "hosted_machines.id"],
            name="fk_hosted_launches_machine",
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'provisioning', 'ready', 'error', 'stopping', 'stopped', 'deleting', 'deleted')",
            name="ck_hosted_launch_state",
        ),
        sa.CheckConstraint(
            "process_state IS NULL OR process_state IN ('pending', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'crashed', 'failed')",
            name="ck_hosted_launch_process_state",
        ),
    )
    _rls("hosted_launches")

    op.add_column("hosted_wake_mailbox", sa.Column("launch_id", sa.Text()))
    op.create_foreign_key(
        "hosted_wake_mailbox_tenant_id_launch_id_fkey",
        "hosted_wake_mailbox",
        "hosted_launches",
        ["tenant_id", "launch_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )

    op.create_table(
        "provider_verifications",
        sa.Column("tenant_id", sa.Text(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("encrypted_credential", sa.Text()),
        sa.Column("encrypted_token", sa.Text()),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("result", sa.Boolean()),
        sa.Column("instance_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deadline", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
    )
    op.create_index(
        "ix_provider_verification_owner",
        "provider_verifications",
        ["tenant_id", "user_id", "provider", "created_at"],
    )
    op.create_index(
        "ix_provider_verification_state",
        "provider_verifications",
        ["tenant_id", "state"],
    )
    _rls("provider_verifications")

    op.create_table(
        "hosted_cutover_volumes",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column(
            "preflight_state", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column("manifest_sha256", sa.Text()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("blocked_reason", sa.Text()),
        sa.Column("imports_queued_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("tenant_id", "launch_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_hosted_cutover_volumes_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "preflight_state IN ('pending', 'blocked', 'complete')",
            name="ck_hosted_cutover_volumes_state",
        ),
    )
    _rls("hosted_cutover_volumes")

    op.create_table(
        "hosted_cutover_items",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column(
            "id",
            sa.Text(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()::text"),
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text()),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text()),
        sa.Column("message_id", sa.Text()),
        sa.Column("thread_id", sa.Text()),
        sa.Column("evidence", JSONB(), nullable=False),
        sa.Column("disposition", sa.Text()),
        sa.Column("payload", JSONB()),
        sa.Column("notice_posted_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("notice_dropped", sa.Text()),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_hosted_cutover_items_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "kind IN ('room_message', 'console_command', 'session', 'request_open', 'reset_pending', 'operation')",
            name="ck_hosted_cutover_items_kind",
        ),
        sa.CheckConstraint(
            "disposition IS NULL OR disposition IN ('ran', 'uncertain', 'unrecoverable', 'import', 'settled_by_host', 'owner_notice', 'interrupted', 'preserved')",
            name="ck_hosted_cutover_items_disposition",
        ),
        sa.CheckConstraint(
            "kind <> 'room_message' OR (room_id IS NOT NULL AND message_id IS NOT NULL)",
            name="ck_hosted_cutover_items_room_message",
        ),
        sa.CheckConstraint(
            "notice_dropped IS NULL OR notice_dropped IN ('agent_deleted')",
            name="ck_hosted_cutover_items_notice_dropped",
        ),
    )
    op.create_index(
        "uq_hosted_cutover_items_room_message",
        "hosted_cutover_items",
        ["tenant_id", "agent_id", "room_id", "message_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'room_message'"),
    )
    op.create_index(
        "ix_hosted_cutover_items_launch",
        "hosted_cutover_items",
        ["tenant_id", "launch_id"],
    )
    _rls("hosted_cutover_items")

    op.create_table(
        "hosted_operations",
        sa.Column("tenant_id", sa.Text(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("error", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("launch_revision", sa.Integer(), nullable=False),
        sa.Column("claimed_by", sa.Text()),
        sa.Column("claimed_boot_id", sa.Text()),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'claimed', 'applied', 'failed', 'unknown')",
            name="ck_hosted_operation_state",
        ),
    )
    _rls("hosted_operations")

    op.create_table(
        "github_issued_tokens",
        sa.Column("tenant_id", sa.Text(), sa.ForeignKey("tenants.id"), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column("launch_revision", sa.Integer(), nullable=False),
        sa.Column("encrypted_token", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoke_requested", sa.Boolean(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("claim_until", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
        ),
    )
    op.create_index(
        "ix_github_issued_tokens_owner",
        "github_issued_tokens",
        ["tenant_id", "owner_id"],
    )
    _rls("github_issued_tokens")
