"""a workspace's auto-route default for new rooms

`tenants.auto_route_new_rooms` says whether a room made in the workspace
starts with auto-route on, unless the room is a direct chat or whoever made it
said otherwise. Off for every workspace, existing and new, so nothing changes
until a workspace admin turns it on.

Expand only: a release from before this revision never reads the column.

Revision ID: 5caa3883fed3
Revises: 95b5d17f4519
Create Date: 2026-11-11 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5caa3883fed3"
down_revision: str | None = "95b5d17f4519"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "auto_route_new_rooms",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("tenants", "auto_route_new_rooms")
