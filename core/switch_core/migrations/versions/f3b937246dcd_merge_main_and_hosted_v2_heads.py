"""merge main's head and the hosted-agents v2 merge

`main` added its own migrations (`063652bcb450` to `10f6d02ac5bc`) after
`9d41b7e2c6a3`, the upstream head `4e634b519462` joined with the hosted-agents
v2 chain. Re-parenting `4e634b519462` would make a database already at it (the
test server) skip main's migrations, so this joins the two heads instead. It
carries no schema of its own, and like `4e634b519462` it is not marked
`expand_only`: `record_expand_only` records a revision with its one parent,
and a merge has two.

Revision ID: f3b937246dcd
Revises: 4e634b519462, 10f6d02ac5bc
Create Date: 2026-11-03

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "f3b937246dcd"
down_revision: str | Sequence[str] | None = ("4e634b519462", "10f6d02ac5bc")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
