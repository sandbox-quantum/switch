"""do not announce reconstructed history

Backfilled messages are numbered below zero — positive is what Switch recorded
as it happened, negative is what was reconstructed from the bus afterwards.
Announcing them would wake every subscriber in the room to read nothing, since
a delivery cursor starts at 0 and is above these positions by construction.

Replaces the trigger function in place; the trigger itself is unchanged.

Revision ID: e83c5a17f4d2
Revises: d4e17b90c3a5
Create Date: 2026-09-03 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "e83c5a17f4d2"
down_revision: str | None = "d4e17b90c3a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

WITH_BACKFILL_GUARD = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    IF NEW.seq <= 0 THEN
        RETURN NULL;
    END IF;
    PERFORM pg_notify(
        'switch_message',
        json_build_object(
            'room_id', NEW.room_id,
            'seq', NEW.seq,
            'id', NEW.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

WITHOUT_BACKFILL_GUARD = """
CREATE OR REPLACE FUNCTION switch_notify_message() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'switch_message',
        json_build_object(
            'room_id', NEW.room_id,
            'seq', NEW.seq,
            'id', NEW.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""


def upgrade() -> None:
    op.execute(WITH_BACKFILL_GUARD)


def downgrade() -> None:
    op.execute(WITHOUT_BACKFILL_GUARD)
