"""Scope Slack request destinations to the owning bridge tenant."""

import sqlalchemy as sa
from alembic import op

revision = "e4f8c1a90372"
down_revision = "c83f6e0a4129"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = "session_request_posts"
    op.add_column(table, sa.Column("tenant_id", sa.Text(), nullable=True))
    op.execute(
        "UPDATE session_request_posts p SET tenant_id = b.tenant_id FROM collaboration_bridges b WHERE b.id = p.bridge_id"
    )
    op.alter_column(table, "tenant_id", nullable=False)
    op.create_foreign_key(
        "fk_session_request_posts_tenant", table, "tenants", ["tenant_id"], ["id"]
    )
    for column, parent, label in [
        ("bridge_id", "collaboration_bridges", "bridge"),
        ("room_id", "rooms", "room"),
    ]:
        op.drop_constraint(f"{table}_{column}_fkey", table, type_="foreignkey")
        op.create_foreign_key(
            f"fk_{table}_{label}",
            table,
            parent,
            ["tenant_id", column],
            ["tenant_id", "id"],
            ondelete="CASCADE",
        )
    op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY tenant_isolation ON "{table}" FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))'
    )


def downgrade() -> None:
    table = "session_request_posts"
    op.execute(f'DROP POLICY tenant_isolation ON "{table}"')
    op.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
    for column, parent, label in [
        ("bridge_id", "collaboration_bridges", "bridge"),
        ("room_id", "rooms", "room"),
    ]:
        op.drop_constraint(f"fk_{table}_{label}", table, type_="foreignkey")
        op.create_foreign_key(
            f"{table}_{column}_fkey",
            table,
            parent,
            [column],
            ["id"],
            ondelete="CASCADE",
        )
    op.drop_constraint("fk_session_request_posts_tenant", table, type_="foreignkey")
    op.drop_column(table, "tenant_id")
