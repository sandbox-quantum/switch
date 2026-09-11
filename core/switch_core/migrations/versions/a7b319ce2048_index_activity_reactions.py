"""Index durable activity reaction holders."""

from alembic import op

revision = "a7b319ce2048"
down_revision = "f5a902bc1843"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_session_activity_reaction",
        "session_activity_posts",
        ["data"],
        postgresql_using="gin",
        postgresql_ops={"data": "jsonb_path_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_session_activity_reaction", table_name="session_activity_posts")
