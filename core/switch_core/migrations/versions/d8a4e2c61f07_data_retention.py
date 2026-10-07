"""data retention: a per-workspace message window, and a seq floor per room

``tenant_retention_policies`` holds at most one row per tenant: how many days
of room messages that workspace keeps. No row means messages are kept forever,
so nothing changes for existing tenants when this runs.

``rooms.seq_floor`` records the highest live ``seq`` retention has deleted
from a room, so numbering continues above it when a room's newest messages
are among those deleted. It starts at 0, which changes nothing for a room
retention has never touched. A downgrade drops it, so a room retention has
emptied numbers from 1 again afterwards; cursors past that point then skip
new messages until they are reset.

Two indexes serve retention's hourly pass, which runs for every tenant:
``ix_message_attachments_tenant_uri`` answers "does any attachment still name
this file" for the file sweep, and ``ix_bridge_message_map_tenant_event``
finds the platform mappings of deleted messages.

**Not `CONCURRENTLY`**, for the reason ``b8f2d0c41e57`` gives: each holds a
lock on its table until the migration commits. A deployment with large
tables can build them by hand first, and this becomes a no-op for them:

    CREATE INDEX CONCURRENTLY ix_message_attachments_tenant_uri
        ON message_attachments (tenant_id, uri);
    CREATE INDEX CONCURRENTLY ix_bridge_message_map_tenant_event
        ON bridge_message_map (tenant_id, transport_event_id);

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: d8a4e2c61f07
Revises: eb24eafa59a0
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8a4e2c61f07"
down_revision: str | None = "eb24eafa59a0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "tenant_retention_policies"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


_INDEXES = (
    ("ix_message_attachments_tenant_uri", "message_attachments", "tenant_id, uri"),
    (
        "ix_bridge_message_map_tenant_event",
        "bridge_message_map",
        "tenant_id, transport_event_id",
    ),
)


def upgrade() -> None:
    # `IF NOT EXISTS` so building them concurrently ahead of time works.
    for name, table, columns in _INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({columns})")
    op.add_column(
        "rooms",
        sa.Column(
            "seq_floor", sa.BigInteger(), server_default=sa.text("0"), nullable=False
        ),
    )
    op.create_table(
        "tenant_retention_policies",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("message_retention_days", sa.Integer(), nullable=False),
        sa.Column("updated_by_user_id", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_tenant_retention_policies_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["updated_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "message_retention_days >= 1 AND message_retention_days <= 3650",
            name="ck_tenant_retention_policies_days",
        ),
        sa.PrimaryKeyConstraint("tenant_id"),
    )
    op.execute('ALTER TABLE "tenant_retention_policies" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    for name, _, _ in _INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "tenant_retention_policies"')
    op.drop_table("tenant_retention_policies")
    op.drop_column("rooms", "seq_floor")
