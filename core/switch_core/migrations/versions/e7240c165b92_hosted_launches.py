"""Record durable hosted-agent launch requests."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e7240c165b92"
down_revision = "c29f7018ea44"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "hosted_launches",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_hosted_launches_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("agent_id", sa.Text()),
        sa.Column("error", sa.Text()),
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
        sa.UniqueConstraint("tenant_id", "name", name="uq_hosted_launch_name"),
        sa.CheckConstraint(
            "state IN ('queued', 'provisioning', 'ready', 'error')",
            name="ck_hosted_launch_state",
        ),
    )
    op.execute("ALTER TABLE hosted_launches ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON hosted_launches FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("hosted_launches")
