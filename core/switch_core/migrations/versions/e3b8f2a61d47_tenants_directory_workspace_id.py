"""tenants.directory_workspace_id: the directory's id for a workspace

An organization created through the WorkOS directory's account service has
one workspace, which the service records on its WorkOS organization. The
workspace Switch makes for it keeps that id, so a rename made in Switch can
be matched to it there.

Expand only: a release before this one neither reads nor writes the column.

Revision ID: e3b8f2a61d47
Revises: c4e1a7d93b52
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e3b8f2a61d47"
down_revision: str | Sequence[str] | None = "c4e1a7d93b52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "tenants", sa.Column("directory_workspace_id", sa.Text(), nullable=True)
    )
    op.create_unique_constraint(
        "tenants_directory_workspace_id_key", "tenants", ["directory_workspace_id"]
    )


def downgrade() -> None:
    op.drop_constraint("tenants_directory_workspace_id_key", "tenants", type_="unique")
    op.drop_column("tenants", "directory_workspace_id")
