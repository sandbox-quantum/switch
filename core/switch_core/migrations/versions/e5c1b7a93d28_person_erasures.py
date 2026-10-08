"""person erasures: a queue of requests to erase one person from a workspace

``person_erasures`` holds each request and its outcome; a background loop
works through the queued ones. ``ix_messages_tenant_sender`` serves
finding and counting a person's messages, which nothing indexed before.

**Not `CONCURRENTLY`**, for the reason ``b8f2d0c41e57`` gives: building it
holds a lock on ``messages``, blocking sends, until the migration commits. A
deployment with a large ``messages`` table should build it by hand first, and
this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_messages_tenant_sender
        ON messages (tenant_id, sender_id);

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: e5c1b7a93d28
Revises: d8a4e2c61f07
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e5c1b7a93d28"
down_revision: str | None = "d8a4e2c61f07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "person_erasures"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


def upgrade() -> None:
    # `IF NOT EXISTS` so building it concurrently ahead of time works.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_messages_tenant_sender "
        "ON messages (tenant_id, sender_id)"
    )
    op.create_table(
        "person_erasures",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "external_user_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column(
            "former_sender_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("requested_by_user_id", sa.Text(), nullable=True),
        sa.Column(
            "messages_deleted",
            sa.BigInteger(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "files_deleted", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "identities_erased",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_person_erasures_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["requested_by_user_id"], ["users.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'done', 'failed')",
            name="ck_person_erasures_state",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_person_erasures_tenant_id", "person_erasures", ["tenant_id"])
    op.execute('ALTER TABLE "person_erasures" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "person_erasures"')
    op.drop_index("ix_person_erasures_tenant_id", table_name="person_erasures")
    op.drop_table("person_erasures")
    op.execute("DROP INDEX IF EXISTS ix_messages_tenant_sender")
