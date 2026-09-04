"""remove the resource manager client record

The resource manager stopped being a Matrix client when the four resource
operations became direct calls on `resource_service`. Nothing registers the
type any more, so a leftover row makes `ClientFactory.create` raise
`Unknown client type: 'resource_manager'` and takes the whole startup with it.

The Matrix account itself is left alone: this migration owns the Switch
database, not the homeserver, and an account nobody logs into costs nothing.

Revision ID: f4c2a8e6d193
Revises: e83c5a17f4d2
Create Date: 2026-09-04 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "f4c2a8e6d193"
down_revision: str | None = "e83c5a17f4d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        DELETE FROM client_rooms
        WHERE client_id IN (SELECT id FROM clients WHERE type = 'resource_manager')
        """
    )
    op.execute("DELETE FROM clients WHERE type = 'resource_manager'")


def downgrade() -> None:
    """Not reversible.

    The row carried a Matrix password and access token that are not recoverable
    from anything left behind, and no code path reads the type any more.
    """
