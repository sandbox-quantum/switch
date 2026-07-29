"""default collaboration bridge (CHOO-1674)

Adds ``is_default`` to ``collaboration_bridges`` so a Switch instance can name
the bridge that new rooms land on when no bridge is given. This is what makes a
standalone deployment usable out of the box: the bundled Mattermost becomes the
default, so every room has a place humans can read it, and internal-only
becomes an explicit opt-out rather than the accident of omitting a field.

A partial unique index enforces "at most one default" in the database rather
than in application code, so two concurrent writers cannot both win.

Existing instances are left without a default on purpose — adopting one is
``setup.py``'s job (it knows which bridge is the bundled one), and silently
promoting an arbitrary existing bridge here could start routing rooms to a
Slack workspace the operator never nominated.

Revision ID: b3f36489c258
Revises: d5e6f7a8b9c0
Create Date: 2026-07-28 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3f36489c258"
down_revision: str | None = "d5e6f7a8b9c0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX_NAME = "ix_collaboration_bridges_single_default"


def upgrade() -> None:
    op.add_column(
        "collaboration_bridges",
        sa.Column(
            "is_default",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )
    op.create_index(
        _INDEX_NAME,
        "collaboration_bridges",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="collaboration_bridges")
    op.drop_column("collaboration_bridges", "is_default")
