"""index tenant_id on the agent management tables

The same index `5b8d2e6f0a41` gives every other tenant table, for the three
agent management tables that had none leading with `tenant_id`. Without it,
the row-level-security filter, a query across one tenant's rows and the
foreign-key check when a tenant row is deleted each scan the whole table.

`IF NOT EXISTS`, as in `5b8d2e6f0a41`, so an index built by hand first with
`CREATE INDEX CONCURRENTLY` makes this a no-op.

Revision ID: c4013951b559
Revises: f06f455739e0
Create Date: 2026-10-05 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c4013951b559"
down_revision: str | Sequence[str] | None = "f06f455739e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLES = (
    "agent_controllers",
    "agent_controller_enrollment_codes",
    "agent_controller_operations",
)


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f'CREATE INDEX IF NOT EXISTS ix_{table}_tenant_id ON "{table}" (tenant_id)'
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(f"DROP INDEX IF EXISTS ix_{table}_tenant_id")
