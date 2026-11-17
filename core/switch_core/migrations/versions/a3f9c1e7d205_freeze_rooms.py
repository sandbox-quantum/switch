"""freeze rooms: `rooms.frozen_at`, `frozen_by` and `frozen_reason`

A workspace admin or the server's operator can freeze a room during an
incident: it stays readable and takes no new posts until they unfreeze it
(`room_read_only.py`). `frozen_at` says since when, `frozen_by` who froze it
(cleared when that account is deleted), and `frozen_reason` why.

`switch_notify_room_changed` and its trigger are redefined so a freeze or an
unfreeze sends `room.changed` as archiving does: every process drops the
room descriptor it kept for agents' posts, which carries whether the room is
frozen. The DDL is a copy of `db/room_access_notify_ddl.py` as it stood when
this revision was written; the downgrade restores the body `4103210581d6`
installed.

Expand only: a release from before this revision reads none of the columns,
and the trigger only sends a signal it already handles.

Revision ID: a3f9c1e7d205
Revises: e5b2c8d4f1a7
Create Date: 2026-11-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f9c1e7d205"
down_revision: str | None = "e5b2c8d4f1a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def _room_notify_function(compared: str) -> str:
    return f"""
CREATE OR REPLACE FUNCTION switch_notify_room_changed() RETURNS trigger AS $$
DECLARE
    changed rooms;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSIF {compared} THEN
        RETURN NULL;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'room.changed',
            'tenant_id', changed.tenant_id,
            'room_id', changed.id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""


_UNCHANGED_BEFORE = """NEW.matrix_room_id IS NOT DISTINCT FROM OLD.matrix_room_id
        AND NEW.name IS NOT DISTINCT FROM OLD.name
        AND NEW.description IS NOT DISTINCT FROM OLD.description
        AND NEW.bridge_id IS NOT DISTINCT FROM OLD.bridge_id
        AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at"""

_UNCHANGED_NOW = f"""{_UNCHANGED_BEFORE}
        AND NEW.frozen_at IS NOT DISTINCT FROM OLD.frozen_at"""

CREATE_ROOM_NOTIFY_TRIGGER = """
CREATE TRIGGER rooms_notify_changed
    AFTER UPDATE OF matrix_room_id, name, description, bridge_id, archived_at,
        frozen_at OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION switch_notify_room_changed()
"""

RESTORE_ROOM_NOTIFY_TRIGGER = """
CREATE TRIGGER rooms_notify_changed
    AFTER UPDATE OF matrix_room_id, name, description, bridge_id, archived_at
        OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION switch_notify_room_changed()
"""


def upgrade() -> None:
    op.add_column(
        "rooms", sa.Column("frozen_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("rooms", sa.Column("frozen_by", sa.Text(), nullable=True))
    op.add_column("rooms", sa.Column("frozen_reason", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_rooms_frozen_by",
        "rooms",
        "users",
        ["frozen_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.execute(_room_notify_function(_UNCHANGED_NOW))
    op.execute("DROP TRIGGER IF EXISTS rooms_notify_changed ON rooms")
    op.execute(CREATE_ROOM_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS rooms_notify_changed ON rooms")
    op.execute(_room_notify_function(_UNCHANGED_BEFORE))
    op.execute(RESTORE_ROOM_NOTIFY_TRIGGER)
    op.drop_constraint("fk_rooms_frozen_by", "rooms", type_="foreignkey")
    op.drop_column("rooms", "frozen_reason")
    op.drop_column("rooms", "frozen_by")
    op.drop_column("rooms", "frozen_at")
