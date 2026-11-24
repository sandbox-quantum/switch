"""hosted operator box counts: the box operator's live boxes and its ceiling,
and an index for box removal

Two nullable columns on `hosted_operator_reports`, from the operator's report
with each claim: how many boxes its box map holds live (entries not listed in
`box-removals`), and the ceiling it refuses new boxes at. Core reports them
as gauges and alerts when the live count nears the ceiling.

And a partial index on `server_audit_events` (action, machine id) over the
four box removal actions only, which box removal reads on every pass.

**Not `CONCURRENTLY`.** Revisions run in a transaction, so this holds a lock
on `server_audit_events` that blocks audited writes while it builds. On the
audit tables deployments have today that's short. For a deployment with a
large `server_audit_events`, build it by hand first and this becomes a no-op:

    CREATE INDEX CONCURRENTLY ix_server_audit_events_box_removal
        ON server_audit_events (action, (details ->> 'machine_id'))
        WHERE action IN ('hosted.box_to_remove', 'hosted.box_to_remove_cancelled',
                         'hosted.box_removal_claimed', 'hosted.box_removed');

Additive: nullable columns nothing older reads or writes, and an index, so an
older Core serves on as before. The downgrade drops them.

Revision ID: 85dfde4a8300
Revises: f7c2a5e9d304
Create Date: 2026-11-24 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "85dfde4a8300"
down_revision: str | Sequence[str] | None = "f7c2a5e9d304"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


_REMOVAL_ACTIONS = (
    "action IN ('hosted.box_to_remove', 'hosted.box_to_remove_cancelled', "
    "'hosted.box_removal_claimed', 'hosted.box_removed')"
)


_INDEX = "ix_server_audit_events_box_removal"


def upgrade() -> None:
    # `IF NOT EXISTS` so the escape hatch above works: an operator who built it
    # concurrently ahead of the upgrade meets a no-op rather than a collision.
    op.execute(
        f"CREATE INDEX IF NOT EXISTS {_INDEX} ON server_audit_events "
        f"(action, (details ->> 'machine_id')) WHERE {_REMOVAL_ACTIONS}"
    )
    op.add_column(
        "hosted_operator_reports", sa.Column("boxes_live", sa.Integer(), nullable=True)
    )
    op.add_column(
        "hosted_operator_reports", sa.Column("box_ceiling", sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")
    op.drop_column("hosted_operator_reports", "box_ceiling")
    op.drop_column("hosted_operator_reports", "boxes_live")
