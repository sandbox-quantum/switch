"""Delete SDK session history with its owning agent."""

from alembic import op

revision = "f10a8c3d6421"
down_revision = "4f2c8a1b60d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("fk_sdk_sessions_agent", "sdk_sessions", type_="foreignkey")
    op.create_foreign_key(
        "fk_sdk_sessions_agent",
        "sdk_sessions",
        "agents",
        ["tenant_id", "agent_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_sdk_sessions_agent", "sdk_sessions", type_="foreignkey")
    op.create_foreign_key(
        "fk_sdk_sessions_agent",
        "sdk_sessions",
        "agents",
        ["tenant_id", "agent_id"],
        ["tenant_id", "id"],
    )
