"""console direct chats that already have another person are groups

A Switch Console chat becomes a group (`channel_private`) once a person other
than its creator is added to it, and a group never addresses its agent without
a mention. Chats that gained such a person before that rule existed are still
`direct`; this converts them. A member held only by an owner grant (the
agent's owner, kept in while the agent is) does not count. Data only, and
one way: the downgrade cannot tell these rooms from groups made since.

Revision ID: d4e8a1c5b7f3
Revises: e5a9c3d71f08
Create Date: 2026-10-21 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "d4e8a1c5b7f3"
down_revision: str | Sequence[str] | None = "e5a9c3d71f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE rooms SET channel_type = 'channel_private'
        WHERE channel_type = 'direct'
          AND metadata ? 'chat_operation_id'
          AND EXISTS (
            SELECT 1 FROM client_rooms cr
            JOIN clients c ON c.id = cr.client_id
            WHERE cr.room_id = rooms.id
              AND c.type = 'member'
              AND c.user_id IS NOT NULL
              AND c.user_id IS DISTINCT FROM rooms.created_by
              AND c.user_id IS DISTINCT FROM rooms.owner_id
              AND NOT EXISTS (
                SELECT 1 FROM chat_owner_grants g
                WHERE g.room_id = rooms.id AND g.user_id = c.user_id
              )
          )
        """
    )


def downgrade() -> None:
    pass
