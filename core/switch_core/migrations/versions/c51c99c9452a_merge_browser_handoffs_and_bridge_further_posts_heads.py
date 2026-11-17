"""Once the join of two migration heads; now an empty step after them.

`368b45a3d82d` and `c4a1f7e2d9b6` were added on the same parent, and this
revision joined them. Every revision since the last release has to be
expand-only with a single parent, so the previous release keeps accepting the
schema; a join has two. `c4a1f7e2d9b6` now follows `368b45a3d82d`, and this
revision keeps its id, so a database that already applied it is unaffected.
"""

revision = "c51c99c9452a"
down_revision = "c4a1f7e2d9b6"
branch_labels = None
depends_on = None
expand_only: bool = True


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
