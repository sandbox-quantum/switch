"""merge main's head and the hosted-agents v2 head a fourth time

`main` added six revisions after `95b5d17f4519`, ending at `c8e2f4a6b1d3`.
One of them, `e3b8d1f6a2c4`, rewrites the same check on
`cloud_machines.stop_reason` that the hosted-agents v2 chain's `d3a7f1c2b8e4`
rewrites: main adds `admin` (an administrator's stop) and v2 adds `paused` and
`turned_off`. Whichever ran last would leave out the other's values, so this
merge sets the check to all of them. As the earlier merges did, it joins the
two heads rather than re-parenting either, so a database at `9b1630d39363`
runs main's six revisions next, then this.

It is not marked `expand_only`: `record_expand_only` records a revision with
its one parent, and a merge has two. Its downgrade leaves the check as it is:
with both parents still applied, all five values stay allowed, and each
parent's own downgrade sets the check it replaced.

Revision ID: 31f9c357ce29
Revises: 9b1630d39363, c8e2f4a6b1d3
Create Date: 2026-11-12

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "31f9c357ce29"
down_revision: str | Sequence[str] | None = ("9b1630d39363", "c8e2f4a6b1d3")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STOP_REASONS = (
    "stop_reason IS NULL OR stop_reason IN "
    "('idle', 'owner', 'paused', 'turned_off', 'admin')"
)


def upgrade() -> None:
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint(
        "ck_cloud_machine_stop_reason", "cloud_machines", _STOP_REASONS
    )


def downgrade() -> None:
    pass
