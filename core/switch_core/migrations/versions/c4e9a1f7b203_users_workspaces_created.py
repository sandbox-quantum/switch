"""users.workspaces_created: the count the workspace-creation bound reads

Revision ID: c4e9a1f7b203
Revises: c4f7e2a90b13

`GATEWAY_MAX_WORKSPACES_PER_USER` bounds how many workspaces one person may
create. Counting the workspaces they currently own let the bound be reset by
handing a workspace to a second account and stepping down, so the bound now
reads a count of creations that only ever goes up.

Existing people start from the workspaces they own today, which is what the
bound counted until now, so nobody gains or loses an allowance when this runs.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e9a1f7b203"
down_revision: str | Sequence[str] | None = "c4f7e2a90b13"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "workspaces_created",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
    )
    op.execute(
        """
        UPDATE users
        SET workspaces_created = owned.n
        FROM (
            SELECT user_id, count(*) AS n
            FROM tenant_members
            WHERE role = 'owner'
            GROUP BY user_id
        ) AS owned
        WHERE users.id = owned.user_id
        """
    )


def downgrade() -> None:
    op.drop_column("users", "workspaces_created")
