"""Merge the service-connections head with the trust-settings merge head.

The service-connection migrations (`4a64c0cbcd9a` onwards) branch from
`cba933f98e1c`, where they were first written and applied, rather than being
moved onto `dce217a97f54`: a database that already ran them keeps a history
Alembic can follow, and still gets the trust-settings migration.

Revision ID: 7c3e91a4d5b2
Revises: 2f7f90dcd163, dce217a97f54
"""

from collections.abc import Sequence

revision: str = "7c3e91a4d5b2"
down_revision: str | Sequence[str] | None = ("2f7f90dcd163", "dce217a97f54")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
