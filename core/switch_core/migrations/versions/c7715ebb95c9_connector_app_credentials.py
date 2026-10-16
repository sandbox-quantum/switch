"""connector app credentials: the operator's apps at connectors' vendors

Two global tables, carrying no tenant and no policy (`db/rls_ddl.py`,
GLOBAL_TABLES):

- `service_app_credentials`: the app the operator registered at a service's
  vendor (a GitHub App, a static OAuth client), entered from the dashboard.
  One row per deployment and service, its secrets encrypted with the keyring.
- `server_audit_events`: the history of changes to the server as a whole,
  append-only for the runtime role as `audit_events` is (the revoke is
  reissued by `grant_runtime_role` on every boot).

And one nullable column, `service_connections.oauth_client_id`: the OAuth
client a sign-in went through. Existing rows stay null, meaning unknown;
there is no data step.

Revision ID: c7715ebb95c9
Revises: bf016e18bc16
Create Date: 2026-10-15 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7715ebb95c9"
down_revision: str | Sequence[str] | None = "bf016e18bc16"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "service_app_credentials",
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("settings", postgresql.JSONB(), nullable=False),
        sa.Column("encrypted_secrets", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("service"),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
    )
    op.create_table(
        "server_audit_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("actor_user_id", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=True),
        sa.Column("details", postgresql.JSONB(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.add_column(
        "service_connections", sa.Column("oauth_client_id", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("service_connections", "oauth_client_id")
    op.drop_table("server_audit_events")
    op.drop_table("service_app_credentials")
