"""switch_core_processes.booting: a process takes work only once it has booted

A process claims its lease early in its boot, so that the others read its
connections and its keys, and they handed it its share of the owned work from
then on, while it could not yet start any of it: a bridge sat with no platform
connection until the boot finished. A process now marks its lease booting
until it can take work promptly, and the others count it as an owner only
once it is not (`ownership.py`).

Expand only: a release before this one writes no value and gets the default,
false, so the others keep counting it as an owner, as it expects.

Revision ID: a25845a0e7be
Revises: a9d3e6f1c2b7
Create Date: 2026-11-12 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a25845a0e7be"
down_revision: str | Sequence[str] | None = "a9d3e6f1c2b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "switch_core_processes",
        sa.Column("booting", sa.Boolean(), server_default="false", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("switch_core_processes", "booting")
