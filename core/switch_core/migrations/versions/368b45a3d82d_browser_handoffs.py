"""browser handoffs: one-time sign-ins Switch Console hands a browser

One global table, carrying no tenant and no policy (`db/rls_ddl.py`,
GLOBAL_TABLES): `browser_handoffs`. Switch Console opens a dashboard page in
the person's own browser, signed in, without handing over its own session: it
mints a code good once, for a minute, and the browser redeems it for a new
session (`gateway/browser_handoff.py`). Only the code's SHA-256 is stored.

`workspace_claim` is what the new session selects, re-checked against a
membership on every request, so it has no foreign key. `console_sid` and
`browser_sid` link the session that minted a code to the one it was redeemed
for, so that signing out of the first signs out the second.

Expand only: a release from before this revision never reads the table, and
answers its routes with 404, which Switch Console takes as a server that opens
the page signed out.

Revision ID: 368b45a3d82d
Revises: a3f61c9d2e47
Create Date: 2026-11-17 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "368b45a3d82d"
down_revision: str | None = "a3f61c9d2e47"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "browser_handoffs"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("workspace_claim", sa.Text(), nullable=True),
        sa.Column("next_path", sa.Text(), nullable=False),
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("session_version", sa.Integer(), nullable=False),
        sa.Column("console_sid", sa.Text(), nullable=True),
        sa.Column("browser_sid", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code_hash", name="uq_browser_handoffs_code_hash"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_browser_handoffs_expires_at", TABLE, ["expires_at"])
    op.create_index(
        "ix_browser_handoffs_user_id_created_at", TABLE, ["user_id", "created_at"]
    )
    op.create_index("ix_browser_handoffs_console_sid", TABLE, ["console_sid"])


def downgrade() -> None:
    op.drop_index("ix_browser_handoffs_console_sid", table_name=TABLE)
    op.drop_index("ix_browser_handoffs_user_id_created_at", table_name=TABLE)
    op.drop_index("ix_browser_handoffs_expires_at", table_name=TABLE)
    op.drop_table(TABLE)
