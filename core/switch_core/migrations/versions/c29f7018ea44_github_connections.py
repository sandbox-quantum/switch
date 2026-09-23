"""Allow GitHub OAuth provider connections."""

from alembic import op

revision = "c29f7018ea44"
down_revision = "ab921ef034cd"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_provider_connections_provider", "provider_connections")
    op.drop_constraint("ck_provider_connections_kind", "provider_connections")
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


def downgrade() -> None:
    op.execute("DELETE FROM provider_connections WHERE provider = 'github'")
    op.drop_constraint("ck_provider_connections_provider", "provider_connections")
    op.drop_constraint("ck_provider_connections_kind", "provider_connections")
    op.create_check_constraint(
        "ck_provider_connections_provider",
        "provider_connections",
        "provider = 'claude'",
    )
    op.create_check_constraint(
        "ck_provider_connections_kind",
        "provider_connections",
        "kind IN ('api-key', 'setup-token')",
    )
