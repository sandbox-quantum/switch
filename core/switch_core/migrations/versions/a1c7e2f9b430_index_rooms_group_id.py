"""index rooms.group_id

group_id is a foreign key with no index, so listing rooms by group and the
ON DELETE SET NULL when a group is removed both scan the rooms table. Mirrors
ix_agents_parent_agent_id.

Revision ID: a1c7e2f9b430
Revises: c8e4a10b7f36
Create Date: 2026-09-09 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a1c7e2f9b430"
down_revision: str | None = "c8e4a10b7f36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_rooms_group_id", "rooms", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_rooms_group_id", table_name="rooms")
