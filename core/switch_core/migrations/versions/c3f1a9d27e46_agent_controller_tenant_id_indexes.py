"""index tenant_id on the agent-controller tables

The same index `5b8d2e6f0a41` added to every other tenant table: these three
arrived on a branch that did not have it yet, so their row-level-security
filter and the tenant foreign-key check still scanned the whole table.

Revision ID: c3f1a9d27e46
Revises: 9ef8e61b06d7
Create Date: 2026-10-05 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c3f1a9d27e46"
down_revision: str | None = "9ef8e61b06d7"
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
