"""cloud machine suspended stop: a box stopped because its owner is suspended

`cloud_machines.stop_reason` may now be `suspended`: suspending an account
(`accounts/suspension.py`) stops the owner's hosted agents v2 box at once
with it, and nothing starts, wakes or reconnects it until the suspension is
lifted, when it becomes `idle` (asleep) again.

Additive in effect: the check only widens, so an older Core, which never
writes `suspended`, reads and writes on as before. The downgrade turns any
`suspended` box into `owner`, stopped, as the closest older value, before
narrowing the check again.

Revision ID: e5c1a8f3b294
Revises: c118ea00053c
Create Date: 2026-11-23 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "e5c1a8f3b294"
down_revision: str | Sequence[str] | None = "c118ea00053c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_OLD = (
    "stop_reason IS NULL OR stop_reason IN "
    "('idle', 'owner', 'paused', 'turned_off', 'admin', 'migration')"
)
_NEW = (
    "stop_reason IS NULL OR stop_reason IN "
    "('idle', 'owner', 'paused', 'turned_off', 'admin', 'migration', 'suspended')"
)


def upgrade() -> None:
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _NEW)


def downgrade() -> None:
    op.execute(
        "UPDATE cloud_machines SET stop_reason = 'owner' WHERE stop_reason = 'suspended'"
    )
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _OLD)
