"""merge the oidc identities and rooms.group_id index heads

Two migrations landed in parallel off the same parent, leaving the chain with
two heads. `alembic upgrade head` is ambiguous with more than one, and the
service runs exactly that at startup, so a deployment not already sitting on
one of the two refuses to boot. Neither head carries schema of its own that the
other needs; this only rejoins them.

Revision ID: b47e0c39a1f5
Revises: 04f27f37e474, a1c7e2f9b430
Create Date: 2026-09-10

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "b47e0c39a1f5"
down_revision: str | Sequence[str] | None = ("04f27f37e474", "a1c7e2f9b430")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
