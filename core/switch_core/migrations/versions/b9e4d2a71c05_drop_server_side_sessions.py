"""Drop the server-side session tables

Revision ID: b9e4d2a71c05
Revises: 545f80e11f13
Create Date: 2026-09-24

A session and its transcript now live only with the host that runs it
(Switch Console or the agent's sidecar), which Console reaches directly. The
server keeps just what `545f80e11f13` added: activity lines and approval
requests. The mirrored sessions, their events and commands, the room
admissions, the posted request cards and the activity publication journal all
go, together with the attachments that were uploaded into a mirrored session.

There is no way back: the rows these tables held cannot be rebuilt from what
is left, so the downgrade refuses rather than recreating empty tables.
"""

from alembic import op

revision: str = "b9e4d2a71c05"
down_revision: str | None = "545f80e11f13"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("session_activity_posts")
    op.drop_table("session_request_posts")
    op.drop_table("sdk_session_commands")
    op.drop_table("sdk_session_events")
    op.execute("DELETE FROM media_blobs WHERE sdk_session_id IS NOT NULL")
    op.drop_constraint("fk_media_blobs_sdk_session", "media_blobs", type_="foreignkey")
    op.drop_index("ix_media_blobs_sdk_session_id", table_name="media_blobs")
    op.drop_column("media_blobs", "sdk_session_id")
    op.drop_table("sdk_room_admissions")
    op.drop_table("sdk_sessions")


def downgrade() -> None:
    raise RuntimeError(
        "b9e4d2a71c05 dropped the server-side session tables and their data; "
        "restore a backup taken before it to go back."
    )
