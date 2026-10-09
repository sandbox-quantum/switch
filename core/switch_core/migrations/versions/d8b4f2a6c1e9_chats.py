"""chats: member clients, retryable chat operations, per-person hidden chats

- `clients.user_id`: the gateway user a `member` client speaks for, one per
  user per tenant.
- `messages.client_txn_id`: a Switch Console sender's key for one part of a
  send, unique per sending client, so a retried send cannot post twice.
- `chat_operations`: a person's retryable requests (create a chat, send,
  upload), keyed by their request id.
- `chat_hidden`: chats a person took off their own list.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Revision ID: d8b4f2a6c1e9
Revises: c3a7e1f0b5d2
Create Date: 2026-10-08 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d8b4f2a6c1e9"
down_revision: str | Sequence[str] | None = "c3a7e1f0b5d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

TABLES = ("chat_operations", "chat_hidden")

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )


def upgrade() -> None:
    op.add_column("clients", sa.Column("user_id", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_clients_user",
        "clients",
        "users",
        ["user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_clients_tenant_user_id", "clients", ["tenant_id", "user_id"]
    )

    op.add_column("messages", sa.Column("client_txn_id", sa.Text(), nullable=True))
    op.create_index(
        "uq_messages_sender_client_txn",
        "messages",
        ["sender_client_id", "client_txn_id"],
        unique=True,
        postgresql_where=sa.text("client_txn_id IS NOT NULL"),
    )

    op.create_table(
        "chat_operations",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("payload_hash", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=True),
        sa.Column("result", postgresql.JSONB(), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "request_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_chat_operations_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_chat_operations_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_operations_room",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "kind IN ('create_chat', 'send', 'upload')",
            name="ck_chat_operations_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'done')", name="ck_chat_operations_state"
        ),
    )

    op.create_table(
        "chat_hidden",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("hidden_through_seq", sa.BigInteger(), nullable=False),
        _timestamp("created_at"),
        sa.PrimaryKeyConstraint("tenant_id", "user_id", "room_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_chat_hidden_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_chat_hidden_user",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_chat_hidden_room",
            ondelete="CASCADE",
        ),
    )

    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(_create_policy(table))


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table}"')
    op.drop_table("chat_hidden")
    op.drop_table("chat_operations")
    op.drop_index("uq_messages_sender_client_txn", table_name="messages")
    op.drop_column("messages", "client_txn_id")
    op.drop_constraint("uq_clients_tenant_user_id", "clients", type_="unique")
    op.drop_constraint("fk_clients_user", "clients", type_="foreignkey")
    op.drop_column("clients", "user_id")
