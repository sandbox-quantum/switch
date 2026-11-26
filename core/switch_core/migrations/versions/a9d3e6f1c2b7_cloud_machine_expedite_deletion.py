"""cloud machines: expedite_deletion

`cloud_machines.expedite_deletion` is set by an organization purge together
with `desired_state = 'deleted'` and `retain_until` now. The hosted
controller, which never brings a deleted machine's retention deadline
forward on its own, takes the earlier date when the flag is on, so a
machine its owner deleted earlier with retention loses its disk at once.
Every existing row starts false, as every delete so far was an ordinary one.

Expand only: a release from before this revision never reads the column and
sends no flag, and a controller from before it ignores the field.

Revision ID: a9d3e6f1c2b7
Revises: f2c8a4d17e93
Create Date: 2026-11-20 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9d3e6f1c2b7"
down_revision: str | None = "f2c8a4d17e93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "cloud_machines",
        sa.Column(
            "expedite_deletion",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("cloud_machines", "expedite_deletion")
