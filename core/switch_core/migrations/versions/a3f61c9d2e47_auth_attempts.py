"""auth attempts: password sign-ins and sign-ups counted per email and address

One global table, carrying no tenant and no policy (`db/rls_ddl.py`,
GLOBAL_TABLES): `auth_attempts`, where `gateway/login_limits.py` counts
failed password sign-ins against the email address typed and the client's
address, and sign-ups against the client's address, so that a limit holds
across replicas. Rows hold digests and counters and expire within minutes.

Expand only: a release from before this revision never reads the table, and
signs people in as it always did.

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


def downgrade() -> None:
    op.drop_index("ix_auth_attempts_expires_at", table_name="auth_attempts")
    op.drop_table("auth_attempts")
