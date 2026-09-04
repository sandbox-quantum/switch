"""index agents.api_key_id

Revision ID: f3b81c47d9a2
Revises: a2171c0de1f4
Create Date: 2026-09-02

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3b81c47d9a2"
down_revision: str | None = "a2171c0de1f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_agents_api_key_id", "agents", ["api_key_id"])


def downgrade() -> None:
    op.drop_index("ix_agents_api_key_id", table_name="agents")
