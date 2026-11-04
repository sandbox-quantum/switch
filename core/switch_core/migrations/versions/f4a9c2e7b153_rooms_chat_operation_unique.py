"""rooms: one room per Switch Console create request

A partial unique index on `(tenant_id, metadata->>'chat_operation_id')`, so a
create retried on another process cannot make a second room for the same
request. Refuses to run while duplicates exist rather than choosing one.

Revision ID: f4a9c2e7b153
Revises: e2c7b9a4d816
Create Date: 2026-10-26 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f4a9c2e7b153"
down_revision: str | Sequence[str] | None = "e2c7b9a4d816"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    duplicates = op.get_bind().scalar(
        sa.text(
            "SELECT count(*) FROM (SELECT 1 FROM rooms "
            "WHERE metadata ? 'chat_operation_id' "
            "GROUP BY tenant_id, metadata ->> 'chat_operation_id' "
            "HAVING count(*) > 1) d"
        )
    )
    if duplicates:
        raise RuntimeError(
            f"rooms: {duplicates} Switch Console create request(s) made more "
            "than one room. Delete the extra rooms (archived rooms count too) "
            "and upgrade again. To list them, or to check before deploying: "
            "SELECT tenant_id, metadata ->> 'chat_operation_id', array_agg(id) "
            "FROM rooms WHERE metadata ? 'chat_operation_id' "
            "GROUP BY 1, 2 HAVING count(*) > 1;"
        )
    op.create_index(
        "uq_rooms_chat_operation_id",
        "rooms",
        ["tenant_id", sa.text("(metadata ->> 'chat_operation_id')")],
        unique=True,
        postgresql_where=sa.text("metadata ? 'chat_operation_id'"),
    )


def downgrade() -> None:
    op.drop_index("uq_rooms_chat_operation_id", table_name="rooms")
