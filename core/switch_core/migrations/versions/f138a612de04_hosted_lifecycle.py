"""Track worker lifecycle and durable session operations."""

import sqlalchemy as sa
from alembic import op

revision = "f138a612de04"
down_revision = "e7240c165b92"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "provider_connections",
        sa.Column(
            "verification_status", sa.Text(), nullable=False, server_default="verified"
        ),
    )
    op.drop_constraint(
        "ck_provider_connections_provider", "provider_connections", type_="check"
    )
    op.drop_constraint(
        "ck_provider_connections_kind", "provider_connections", type_="check"
    )
    op.create_check_constraint(
        "ck_provider_connections_provider",
        "provider_connections",
        "provider IN ('claude', 'github', 'codex', 'opencode', 'cursor', 'antigravity')",
    )
    op.create_check_constraint(
        "ck_provider_connections_kind",
        "provider_connections",
        "(provider = 'claude' AND kind IN ('api-key', 'setup-token')) OR (provider = 'github' AND kind = 'oauth') OR (provider = 'codex' AND kind IN ('api-key', 'auth-json')) OR (provider = 'cursor' AND kind = 'api-key') OR (provider IN ('opencode', 'antigravity') AND kind = 'auth-json')",
    )
    op.add_column(
        "hosted_launches",
        sa.Column("desired_state", sa.Text(), nullable=False, server_default="running"),
    )
    op.add_column(
        "hosted_launches",
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
    )
    op.drop_constraint("ck_hosted_launch_state", "hosted_launches", type_="check")
    op.create_check_constraint(
        "ck_hosted_launch_state",
        "hosted_launches",
        "state IN ('queued', 'provisioning', 'ready', 'error', 'stopping', 'stopped', 'deleting', 'deleted')",
    )
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
    op.execute("ALTER TABLE hosted_operations ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON hosted_operations FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM provider_connections WHERE provider NOT IN ('claude', 'github')"
    )
    op.drop_constraint(
        "ck_provider_connections_provider", "provider_connections", type_="check"
    )
    op.drop_constraint(
        "ck_provider_connections_kind", "provider_connections", type_="check"
    )
    op.create_check_constraint(
        "ck_provider_connections_provider",
        "provider_connections",
        "provider IN ('claude', 'github')",
    )
    op.create_check_constraint(
        "ck_provider_connections_kind",
        "provider_connections",
        "(provider = 'claude' AND kind IN ('api-key', 'setup-token')) OR (provider = 'github' AND kind = 'oauth')",
    )
    op.drop_column("provider_connections", "verification_status")
    op.drop_table("hosted_operations")
    op.drop_constraint("ck_hosted_launch_state", "hosted_launches", type_="check")
    op.execute(
        "UPDATE hosted_launches SET state = 'error' WHERE state NOT IN ('queued', 'provisioning', 'ready', 'error')"
    )
    op.create_check_constraint(
        "ck_hosted_launch_state",
        "hosted_launches",
        "state IN ('queued', 'provisioning', 'ready', 'error')",
    )
    op.drop_column("hosted_launches", "revision")
    op.drop_column("hosted_launches", "desired_state")
