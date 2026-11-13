"""cloud machine backend: `vm` or `box`

Which kind of thing runs a user's cloud machine, so a v1 EC2 machine and a v2
cluster box can sit on one Core and neither side touches the other's. Every
existing row is a v1 machine, so the column's default is `vm`; box provisioning
marks the rows it makes or revives `box`.

Additive: a new column with a server default and a check, so an older Core,
which never names it, inserts `vm` rows and reads on as before. The downgrade
refuses while any `box` row exists, since dropping the column would make a box
look like an EC2 machine to the older controller.

Revision ID: a90e3df4fe3f
Revises: eb7e622cf3b0
Create Date: 2026-10-29 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "a90e3df4fe3f"
down_revision: str | Sequence[str] | None = "eb7e622cf3b0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_CHECK = "ck_cloud_machine_backend"


def upgrade() -> None:
    op.add_column(
        "cloud_machines",
        sa.Column("backend", sa.Text(), nullable=False, server_default="vm"),
    )
    op.create_check_constraint(_CHECK, "cloud_machines", "backend IN ('vm', 'box')")


def downgrade() -> None:
    boxes = (
        op.get_bind()
        .execute(text("SELECT count(*) FROM cloud_machines WHERE backend = 'box'"))
        .scalar_one()
    )
    if boxes:
        raise RuntimeError(
            f"cloud_machines has {boxes} box row(s); an older controller would "
            "take them for EC2 machines. Remove them deliberately before downgrading"
        )
    op.drop_constraint(_CHECK, "cloud_machines", type_="check")
    op.drop_column("cloud_machines", "backend")
