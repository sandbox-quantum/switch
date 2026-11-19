"""auth attempts and revoked sessions

Two global tables, carrying no tenant and no policy (`db/rls_ddl.py`,
GLOBAL_TABLES):

- `auth_attempts`, where `gateway/login_limits.py` counts failed password
  sign-ins against the email address typed and the client's address, and
  sign-ups against the client's address, so that a limit holds across
  replicas. Rows hold digests and counters and expire within minutes.
- `revoked_sessions`, the sessions someone signed out of (`/auth/logout`):
  a session cookie whose `sid` is here is refused. A row is kept until no
  copy of its session could still be live, and pruned by a later sign-out.

Expand only: a release from before this revision never reads either table.
It signs people in as it always did, and does not refuse a session signed
out of on this one.

Revision ID: a3f61c9d2e47
Revises: e2c7a94f1b38
Create Date: 2026-11-16 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f61c9d2e47"
down_revision: str | None = "e2c7a94f1b38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "auth_attempts",
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("kind", "key"),
    )
    op.create_index("ix_auth_attempts_expires_at", "auth_attempts", ["expires_at"])
    op.create_table(
        "revoked_sessions",
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("session_id"),
    )
    op.create_index(
        "ix_revoked_sessions_expires_at", "revoked_sessions", ["expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_revoked_sessions_expires_at", table_name="revoked_sessions")
    op.drop_table("revoked_sessions")
    op.drop_index("ix_auth_attempts_expires_at", table_name="auth_attempts")
    op.drop_table("auth_attempts")
