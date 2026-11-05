"""collaboration_bridges: retire the bundled Mattermost bridge

Switch no longer ships its own Mattermost server or the setup step that
registered it as the default bridge (the only connector ever registered as
`preconfigured`). Left active it would fail to reach a server that is gone on
every boot, and left as the default every room created without a named bridge
would fail (the default must be running). It is marked retiring, which nothing
starts, and stops being the default. Moving its rooms into Switch Console needs
the running server, so boot does it
(`RoomService.retire_bundled_mattermost_bridges`) and then marks the row
inactive.

Mattermost bridges a user connected to their own server are not preconfigured
and are untouched: they stay active, and the default if they were.

Revision ID: e5b2c8d4f1a7
Revises: c8e4a1f7d392
Create Date: 2026-11-05 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "e5b2c8d4f1a7"
down_revision: str | Sequence[str] | None = "c8e4a1f7d392"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Runs as the schema owner, which row-level security does not restrict, so
    # every tenant's connectors are seen.
    op.execute(
        "UPDATE collaboration_bridges SET status = 'retiring', is_default = false "
        "WHERE type = 'mattermost' AND preconfigured"
    )


def downgrade() -> None:
    # Which rows were active or the default beforehand is not recorded, and the
    # server they reached is no longer shipped.
    pass
