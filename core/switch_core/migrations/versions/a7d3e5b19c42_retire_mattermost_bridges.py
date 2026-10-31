"""collaboration_bridges: retire Mattermost connectors

Switch no longer ships a Mattermost adapter. A Mattermost row left active
would fail to start on every boot, and one left as the default would make
every room created without a named bridge fail (the default must be running).
Each is marked retiring, which nothing starts, and stops being the default.
Moving its rooms into Switch Console needs the running server, so boot does it
(`RoomService.retire_mattermost_bridges`) and then marks the row inactive.

Revision ID: a7d3e5b19c42
Revises: b7e1d4c9a2f6
Create Date: 2026-10-27 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "a7d3e5b19c42"
down_revision: str | Sequence[str] | None = "b7e1d4c9a2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Runs as the schema owner, which row-level security does not restrict, so
    # every tenant's connectors are seen.
    op.execute(
        "UPDATE collaboration_bridges SET status = 'retiring', is_default = false "
        "WHERE type = 'mattermost'"
    )


def downgrade() -> None:
    # Which rows were active or the default beforehand is not recorded, and no
    # adapter exists to run them again.
    pass
