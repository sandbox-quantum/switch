"""chat reads: how far each person has read each chat

`chat_reads` holds one row per person per room: the last room position they
were shown, which only moves forward. Every current member of a room starts
read up to its head, so a chat's history is not all unread on upgrade.

The row-level-security DDL is the same as `d8b4f2a6c1e9` writes for the other
chat tables, copied rather than imported for the reason `265ed188ad6f` gives.

Revision ID: e2c7b9a4d816
Revises: d4e8a1c5b7f3
Create Date: 2026-10-26 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e2c7b9a4d816"
down_revision: str | Sequence[str] | None = "d4e8a1c5b7f3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

POLICY_NAME = "tenant_isolation"
_PREDICATE = '"tenant_id" = (SELECT require_tenant_id())'


def upgrade() -> None:
    op.create_table(
        "chat_reads",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("read_through_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "room_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_chat_reads_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_chat_reads_user", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_reads_room",
            ondelete="CASCADE",
        ),
    )
    op.execute('ALTER TABLE "chat_reads" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY {POLICY_NAME} ON "chat_reads"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )
    op.execute(
        """
        INSERT INTO chat_reads (tenant_id, user_id, room_id, read_through_seq)
        SELECT c.tenant_id, c.user_id, cr.room_id,
               COALESCE((SELECT max(m.seq) FROM messages m
                         WHERE m.room_id = cr.room_id), 0)
        FROM client_rooms cr
        JOIN clients c ON c.id = cr.client_id
        WHERE c.type = 'member' AND c.user_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "chat_reads"')
    op.drop_table("chat_reads")
