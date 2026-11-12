"""rooms keep no write visibility of their own

Changing a room became its owner's and the admins' (`room_policy`), so a
room's write visibility grants nothing. Every room is now stored
write-private, and new rooms default to it, so "Public — read & write" and
"Public — read only" stop being two values for the same behaviour. Who can
see a room (`read_visibility`) is untouched.

Marked `expand_only`: the schema is unchanged, and a process from before the
room permission tiers keeps working against it. Reading every room as
write-private, it stops letting everyone change a room that was public
read & write, which is what the tiers decide anyway, so a rolling deploy only
brings that forward. Data only, and one way: the downgrade cannot tell which
rooms were read & write.

Revision ID: b7e2c4a9d1f6
Revises: d41f9a7c2e58
Create Date: 2026-11-10 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "b7e2c4a9d1f6"
down_revision: str | Sequence[str] | None = "d41f9a7c2e58"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.alter_column("rooms", "write_visibility", server_default="private")
    op.execute(
        "UPDATE rooms SET write_visibility = 'private' "
        "WHERE write_visibility <> 'private'"
    )


def downgrade() -> None:
    op.alter_column("rooms", "write_visibility", server_default="public")
