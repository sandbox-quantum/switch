"""hosted pause and the per-person switch

Three small changes, for an operator pausing a user and a workspace
admin turning hosted agents off for one person (A2):

- `users.hosted_paused_at`, nullable: when an operator paused this user. The
  pause itself, user-wide, kept on the user so it outlives any box row and a
  sign-in's write to `users.metadata` can't clear it.
- `cloud_machines.stop_reason` may also be `paused` (an operator's pause) or
  `turned_off` (the box's only workspace turned its owner off).
- `tenant_members.hosted_enabled`, not null, default true: every existing
  member keeps today's access. The server's own lists still decide who may use
  hosted agents at all; this only narrows within an allowed workspace.

The downgrade refuses while any user is paused (a `hosted_paused_at`, or a box
stopped as `paused`) or turned off (a member with `hosted_enabled` false, or a
box stopped as `turned_off`): it would quietly undo the operator's or the
admin's decision. Resume them, or turn them on, first. Only with
`SWITCH_ALLOW_DROP_HOSTED_MARKS=1` set does it go ahead anyway, relabelling
those boxes `owner` (stopped, but startable) and dropping the marks: the
person running it has chosen to restore that access. Then it restores the
old check and drops both columns.

Revision ID: d3a7f1c2b8e4
Revises: c7715ebb95c9
Create Date: 2026-10-29 00:00:00.000000

"""

import logging
import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3a7f1c2b8e4"
down_revision: str | Sequence[str] | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

logger = logging.getLogger("alembic.runtime.migration")

_OVERRIDE = "SWITCH_ALLOW_DROP_HOSTED_MARKS"
_OLD = "stop_reason IS NULL OR stop_reason IN ('idle', 'owner')"
_NEW = "stop_reason IS NULL OR stop_reason IN ('idle', 'owner', 'paused', 'turned_off')"


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("hosted_paused_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _NEW)
    op.add_column(
        "tenant_members",
        sa.Column(
            "hosted_enabled",
            sa.Boolean(),
            nullable=False,
            server_default="true",
        ),
    )


def downgrade() -> None:
    connection = op.get_bind()
    blocked = connection.execute(
        sa.text(
            "SELECT (SELECT count(*) FROM users WHERE hosted_paused_at IS NOT NULL)"
            " + (SELECT count(*) FROM tenant_members WHERE NOT hosted_enabled)"
            " + (SELECT count(*) FROM cloud_machines"
            "    WHERE stop_reason IN ('paused', 'turned_off'))"
        )
    ).scalar_one()
    if blocked and os.environ.get(_OVERRIDE) != "1":
        raise RuntimeError(
            f"Refusing to downgrade: {blocked} paused or turned-off users or boxes. "
            "Downgrading would undo that. Resume them, or turn them on, first, "
            f"or set {_OVERRIDE}=1 to restore their access on purpose."
        )
    if blocked:
        # The override was set: say so once, with the count, before acting.
        logger.warning(
            "%s=1: downgrading with %d paused or turned-off users or boxes; "
            "their hosted access is restored",
            _OVERRIDE,
            blocked,
        )
    op.drop_column("tenant_members", "hosted_enabled")
    op.execute(
        "UPDATE cloud_machines SET stop_reason = 'owner' "
        "WHERE stop_reason IN ('paused', 'turned_off')"
    )
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _OLD)
    op.drop_column("users", "hosted_paused_at")
