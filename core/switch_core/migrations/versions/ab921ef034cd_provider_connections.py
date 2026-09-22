"""Store verified provider credentials per tenant and user."""

import sqlalchemy as sa
from alembic import op

revision = "ab921ef034cd"
down_revision = "2d84b6f1c705"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "provider_connections",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_provider_connections_tenant"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("encrypted_credential", sa.Text(), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "provider"),
        sa.CheckConstraint(
            "provider = 'claude'", name="ck_provider_connections_provider"
        ),
        sa.CheckConstraint(
            "kind IN ('api-key', 'setup-token')", name="ck_provider_connections_kind"
        ),
    )
    op.execute("ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON provider_connections FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("provider_connections")
