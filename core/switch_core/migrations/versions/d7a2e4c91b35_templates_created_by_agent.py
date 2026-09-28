"""record which agent saved a template

Revision ID: d7a2e4c91b35
Revises: a3c9e1f7b2d4

Agents can now save templates. ``templates.created_by_agent_id`` records which
agent saved one, the same way ``rooms.created_by_agent_id`` does for rooms;
``owner_id`` stays the agent's owner, so tenancy and visibility are unchanged.
Only that agent may change or delete what it saved.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7a2e4c91b35"
down_revision: str | Sequence[str] | None = "a3c9e1f7b2d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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


def downgrade() -> None:
    op.drop_constraint("fk_templates_created_by_agent", "templates", type_="foreignkey")
    op.drop_column("templates", "created_by_agent_id")
