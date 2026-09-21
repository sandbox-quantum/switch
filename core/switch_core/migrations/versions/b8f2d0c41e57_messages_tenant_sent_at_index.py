"""index messages on (tenant_id, sent_at) for the usage snapshot

The snapshot asks the message table several questions a day, all of the shape
"this tenant's messages since a moment": traffic in the last day, who sent it,
distinct humans who interacted over a week, the distinct rooms they interacted
in, and attachments. `ix_messages_room_sent_at` cannot serve any of them — its
leading column is `room_id` and none of these name a room — so each was a
sequential scan of the busiest table in the schema, once per tenant per pass.

Nothing else needed it: the read path pages within a room and the existing
index serves that.

**Not `CONCURRENTLY`, which is a judgement about when this lands.** Revisions
run in a transaction, so this holds `ACCESS EXCLUSIVE` on `messages` until the
migration commits — milliseconds at the size every deployment has today, and
one that later grows will have had the index since before it did.
`CONCURRENTLY` would need an `autocommit_block`, which cannot roll back.

For a deployment that already has a large `messages` table, build it by hand
first and this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_messages_tenant_sent_at
        ON messages (tenant_id, sent_at);

Revision ID: b8f2d0c41e57
Revises: a7e1c4b90d23
Create Date: 2026-09-17 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b8f2d0c41e57"
down_revision: str | None = "a7e1c4b90d23"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX = "ix_messages_tenant_sent_at"


def upgrade() -> None:
    # `IF NOT EXISTS` so the escape hatch above works: an operator who built it
    # concurrently ahead of the upgrade meets a no-op rather than a collision.
    op.execute(f"CREATE INDEX IF NOT EXISTS {_INDEX} ON messages (tenant_id, sent_at)")


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")
