"""service oauth clients: the OAuth client Core registered at a vendor

Some vendors offer no OAuth client to configure, only dynamic client
registration (RFC 7591). Core registers one on the first connect and keeps it
here: one row per deployment and service, its registration answer encrypted
with the keyring. Deployment-wide, so it carries no tenant and no policy
(`db/rls_ddl.py`, GLOBAL_TABLES).

Revision ID: 2f7f90dcd163
Revises: dfc2a46131f1
Create Date: 2026-10-08 16:19:01.773018

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "2f7f90dcd163"
down_revision: str | Sequence[str] | None = "dfc2a46131f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "service_oauth_clients",
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("registration_endpoint", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("encrypted_secret", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("service"),
    )


def downgrade() -> None:
    op.drop_table("service_oauth_clients")
