"""client_rooms_notify: signal every switch-core process when a membership changes

Each switch-core process runs its own copy of every client, and a membership
was only ever announced to the copy in the process that wrote it, through an
in-process bus. A client added to a room through one process read nothing
there from any other, and one removed kept reading it. This trigger sends a
`membership.changed` signal on the `switch_signal` channel for every row
inserted into or deleted from `client_rooms`, so every process re-reads that
client's memberships.

Revision ID: e5b2c8d1f7a3
Revises: c4d8e2f6a913
Create Date: 2026-10-14 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "e5b2c8d1f7a3"
down_revision: str | None = "c4d8e2f6a913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Copies of the DDL in `db/membership_notify_ddl.py`, written out here so this
# migration keeps creating the same objects if that module changes.
CREATE_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_membership() RETURNS trigger AS $$
DECLARE
    changed client_rooms;
BEGIN
    IF TG_OP = 'DELETE' THEN
        changed := OLD;
    ELSE
        changed := NEW;
    END IF;
    PERFORM pg_notify(
        'switch_signal',
        json_build_object(
            'kind', 'membership.changed',
            'tenant_id', changed.tenant_id,
            'client_id', changed.client_id,
            'room_id', changed.room_id
        )::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

CREATE_NOTIFY_TRIGGER = """
CREATE TRIGGER client_rooms_notify
    AFTER INSERT OR DELETE ON client_rooms
    FOR EACH ROW EXECUTE FUNCTION switch_notify_membership()
"""


def upgrade() -> None:
    op.execute(CREATE_NOTIFY_FUNCTION)
    op.execute(CREATE_NOTIFY_TRIGGER)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS client_rooms_notify ON client_rooms")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_membership()")
