"""Track temporary provider verification workers."""

import sqlalchemy as sa
from alembic import op

revision = "a472be90d1f6"
down_revision = "f138a612de04"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
    op.execute("ALTER TABLE provider_verifications ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON provider_verifications FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("provider_verifications")
