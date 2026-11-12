"""when telemetry was switched on, and when each cloud machine was first ready

Two nullable columns, both read only by product telemetry:

- `deployment_identity.telemetry_enabled_since`: set at a boot with
  telemetry on when it is empty, and emptied at a boot with it off
  (`telemetry/setup.py`). The period counts are dated no earlier than it, and
  report no period that ended before it, so nothing is dated before the
  deployment agreed to report. Backfilled from the best evidence of when an
  upgraded deployment began reporting: when it claimed `deployment_installed`,
  which a released server does at its first boot with telemetry on; failing
  that, for one that has sent a snapshot, its install, or else its last
  snapshot. One with no sign of having reported is left empty, for its first
  boot with telemetry on to set.
- `cloud_machines.first_ready_at`: when the machine first became ready, so
  `cloud_machine_ready` can tell a new machine from one starting again by
  whether it has been ready before, where it asked whether the machine was at
  its first revision. Backfilled for a machine whose controller has reported,
  which it can do only once the machine is up, with the latest report: the
  machine had been ready by then, which is all the column has to answer.

Expand only: a process from before this revision never reads either column.

Revision ID: 861ff8767cf4
Revises: d3a8f1c62b07
Create Date: 2026-11-09 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "861ff8767cf4"
down_revision: str | Sequence[str] | None = "d3a8f1c62b07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "deployment_identity",
        sa.Column("telemetry_enabled_since", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        """
        UPDATE deployment_identity SET telemetry_enabled_since = COALESCE(
            (
                SELECT emitted_at FROM telemetry_milestones
                WHERE name = 'deployment_installed'
            ),
            CASE WHEN EXISTS (SELECT 1 FROM telemetry_snapshot_watermark) THEN
                COALESCE(
                    installed_at,
                    (SELECT last_sent_at FROM telemetry_snapshot_watermark LIMIT 1)
                )
            END
        )
        """
    )
    op.add_column(
        "cloud_machines",
        sa.Column("first_ready_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        "UPDATE cloud_machines SET first_ready_at = heartbeat_at "
        "WHERE heartbeat_at IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("cloud_machines", "first_ready_at")
    op.drop_column("deployment_identity", "telemetry_enabled_since")
