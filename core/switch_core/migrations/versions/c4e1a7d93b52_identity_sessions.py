"""identity sessions: the AuthKit sessions gateway sign-ins stand on

`identity_sessions` records, for a sign-in through WorkOS AuthKit, the
person's session at WorkOS, so the gateway can follow it and end it
(`db/models.py`'s `IdentitySession`). A global table, like `users` and
`oidc_identities`: no tenant column and no row-level security policy
(`db/rls_ddl.py`'s `GLOBAL_TABLES`). Its rows go with the account.

`browser_handoffs.identity_session` carries the identity session of the
Switch Console session that minted a sign-in link to the browser session it
is redeemed for, so that session ends with it too. Like `console_sid`, it has
no foreign key: it is read once, at redemption.

Expand only: a release from before this revision neither reads nor writes
the table or the column.

Revision ID: c4e1a7d93b52
Revises: f3a9c1d7e2b4
Create Date: 2026-11-17 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e1a7d93b52"
down_revision: str | None = "f3a9c1d7e2b4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "identity_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("followed", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "checked_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_identity_sessions_user_id", "identity_sessions", ["user_id"])
    op.create_index(
        "uq_identity_sessions_live_session",
        "identity_sessions",
        ["provider", "session_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
    )
    op.add_column(
        "browser_handoffs", sa.Column("identity_session", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("browser_handoffs", "identity_session")
    op.drop_index("uq_identity_sessions_live_session", table_name="identity_sessions")
    op.drop_index("ix_identity_sessions_user_id", table_name="identity_sessions")
    op.drop_table("identity_sessions")
