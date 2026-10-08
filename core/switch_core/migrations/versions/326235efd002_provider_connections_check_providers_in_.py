"""provider connections: check providers in the application

Drops `ck_provider_connections_provider` and `ck_provider_connections_kind`.
Which agent providers exist, and which credential kinds each takes, is the
provider table in `switch_core.providers.registry`; the routes that write a
connection check against it (`providers/credentials.py`), so adding a provider
needs no migration. GitHub connections are written only by the GitHub link
flow, always as `oauth`.

The downgrade restores both constraints as they were, first deleting any row
they would refuse (a connection for a provider added since), as the downgrade
of `f138a612de04` does.

Revision ID: 326235efd002
Revises: fabf9b9bff78
Create Date: 2026-10-08 13:18:55.482052

"""

from collections.abc import Sequence

from alembic import op

revision: str = "326235efd002"
down_revision: str | None = "fabf9b9bff78"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PROVIDER_CHECK = (
    "provider IN ('claude', 'github', 'codex', 'opencode', 'cursor', 'antigravity')"
)
KIND_CHECK = "(provider = 'claude' AND kind IN ('api-key', 'setup-token')) OR (provider = 'github' AND kind = 'oauth') OR (provider = 'codex' AND kind IN ('api-key', 'auth-json')) OR (provider = 'cursor' AND kind = 'api-key') OR (provider IN ('opencode', 'antigravity') AND kind = 'auth-json')"


def upgrade() -> None:
    op.drop_constraint(
        "ck_provider_connections_provider", "provider_connections", type_="check"
    )
    op.drop_constraint(
        "ck_provider_connections_kind", "provider_connections", type_="check"
    )


def downgrade() -> None:
    op.execute(
        f"DELETE FROM provider_connections WHERE NOT ({PROVIDER_CHECK}) OR NOT ({KIND_CHECK})"
    )
    op.create_check_constraint(
        "ck_provider_connections_provider", "provider_connections", PROVIDER_CHECK
    )
    op.create_check_constraint(
        "ck_provider_connections_kind", "provider_connections", KIND_CHECK
    )
