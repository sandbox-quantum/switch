"""record which agent saved a template, and keep the requests agents are refused

Revision ID: d7a2e4c91b35
Revises: a3c9e1f7b2d4

Agents can now save templates. ``templates.created_by_agent_id`` records which
agent saved one, the same way ``rooms.created_by_agent_id`` does for rooms;
``owner_id`` stays the agent's owner, so tenancy and visibility are unchanged.
Only that agent may change or delete what it saved.

``agent_refusals`` keeps each request an agent made that the server refused,
with the reason, so people can see what agents are asked to do and cannot.
It is tenant-scoped like every table holding customer data and arrives with
row-level security on. The DDL is a copy of ``switch_core/db/rls_ddl.py`` as
it stands, for the reason ``265ed188ad6f`` gives.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7a2e4c91b35"
down_revision: str | Sequence[str] | None = "a3c9e1f7b2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "agent_refusals"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


def upgrade() -> None:
    op.add_column(
        "templates", sa.Column("created_by_agent_id", sa.Text(), nullable=True)
    )
    op.create_foreign_key(
        "fk_templates_created_by_agent",
        "templates",
        "agents",
        ["tenant_id", "created_by_agent_id"],
        ["tenant_id", "id"],
        ondelete="SET NULL (created_by_agent_id)",
    )

    op.create_table(
        "agent_refusals",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("agent_name", sa.Text(), nullable=False),
        sa.Column(
            "owner_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_agent_refusals_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_refusals_agent",
            ondelete="SET NULL (agent_id)",
        ),
        sa.UniqueConstraint("id", "tenant_id", name="uq_agent_refusals_id_tenant"),
    )
    op.create_index(
        "ix_agent_refusals_owner_id_created_at",
        "agent_refusals",
        ["owner_id", "created_at"],
    )
    op.execute('ALTER TABLE "agent_refusals" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "agent_refusals"')
    op.drop_index("ix_agent_refusals_owner_id_created_at", table_name="agent_refusals")
    op.drop_table("agent_refusals")
    op.drop_constraint("fk_templates_created_by_agent", "templates", type_="foreignkey")
    op.drop_column("templates", "created_by_agent_id")
