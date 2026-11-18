"""agent_controllers.device_hash: which machine and account a controller runs on

A controller enrolling again on a machine and OS account its owner already
has a device for (a reinstall, a fresh data directory) takes that device over
when it is not running, agents and all, instead of adding another of the same
name. The column holds the SHA-256 of the owner's id and the device id the
controller derives, and is indexed for the lookup at enrollment.

Expand only: a release from before this revision never reads the column, and
an insert that leaves it out stores NULL.

Revision ID: f3a9c1d7e2b4
Revises: e5b2c8d4f1a7
Create Date: 2026-11-18 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3a9c1d7e2b4"
down_revision: str | None = "e5b2c8d4f1a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "agent_controllers", sa.Column("device_hash", sa.Text(), nullable=True)
    )
    op.create_index(
        "ix_agent_controllers_device_hash",
        "agent_controllers",
        ["tenant_id", "owner_id", "device_hash"],
        postgresql_where=sa.text("device_hash IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_agent_controllers_device_hash", table_name="agent_controllers")
    op.drop_column("agent_controllers", "device_hash")
