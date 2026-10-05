"""agents.oauth_client_id unique across the deployment

An agent signing in with an OIDC token is identified by the token's client id
before any tenant is known, so the id has to name one agent deployment-wide.
Without a constraint two tenants could register the same one, and the
sign-in lookup would then refuse both. A partial unique index makes the second
registration fail instead; agents without an OAuth client are unaffected.

Revision ID: 3e9a6c2b7f14
Revises: a9e1c3f75b20
Create Date: 2026-10-01 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3e9a6c2b7f14"
down_revision: str | None = "a9e1c3f75b20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "uq_agents_oauth_client_id"


def upgrade() -> None:
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT oauth_client_id FROM agents "
                "WHERE oauth_client_id IS NOT NULL "
                "GROUP BY oauth_client_id HAVING count(*) > 1"
            )
        )
        .scalars()
        .all()
    )
    if duplicates:
        raise RuntimeError(
            "Cannot make agents.oauth_client_id unique: these client ids are "
            f"held by more than one agent: {', '.join(duplicates)}. Clear the "
            "id on all but one agent each, then run the migration again."
        )
    op.create_index(
        INDEX,
        "agents",
        ["oauth_client_id"],
        unique=True,
        postgresql_where=sa.text("oauth_client_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(INDEX, table_name="agents")
