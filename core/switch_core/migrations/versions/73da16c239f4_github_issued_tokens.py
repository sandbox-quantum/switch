"""Retain issued repository tokens until revocation or expiry."""

import sqlalchemy as sa
from alembic import op

revision = "73da16c239f4"
down_revision = "62cf05b128e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
    op.execute("ALTER TABLE github_issued_tokens ENABLE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON github_issued_tokens FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def downgrade() -> None:
    op.drop_table("github_issued_tokens")
