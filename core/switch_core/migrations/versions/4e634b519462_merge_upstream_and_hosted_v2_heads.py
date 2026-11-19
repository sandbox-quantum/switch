"""merge upstream's head and the hosted-agents v2 chain

The hosted-agents v2 migrations (`d3a7f1c2b8e4` to `e11b7c3d9a2f`) branch from
`c7715ebb95c9`, as do upstream's later ones (`f68b679599ab` to
`9d41b7e2c6a3`). Re-parenting either chain would make a database already at
the other's head skip its migrations, so this joins the two heads instead,
the way `e5a9c3d71f08` does. It carries no schema of its own, and like
`e5a9c3d71f08` it is not marked `expand_only`: `record_expand_only` records
a revision with its one parent, and a merge has two.

Revision ID: 4e634b519462
Revises: 9d41b7e2c6a3, e11b7c3d9a2f
Create Date: 2026-11-02

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "4e634b519462"
down_revision: str | Sequence[str] | None = ("9d41b7e2c6a3", "e11b7c3d9a2f")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
