"""hosted migrations: moving a person from a v1 machine to a v2 box

Two additive changes for the operator's move of one person's v1 machine (an
EC2 VM and its disk) to a v2 box, in place on the same machine row:

- `hosted_migrations`, one row per person: the step last finished, so a run
  carries on from there, and the v1 machine's instance, disk and type, so a
  rollback can hand the same disk back to the v1 controller. Global, as
  `cloud_machines` is, and it names no workspace. The person's row goes with
  their account (`ON DELETE CASCADE`); account deletion is refused anyway
  while their machine is there.
- `cloud_machines.stop_reason` may also be `migration`: the move's hold, on
  the v1 machine (the freeze) and on the box while its files are copied. Only
  the move clears it, so nothing starts the machine mid-move and the idle
  clean-up never retains it.
- `machine_workspaces.moving_from_controller_id`, nullable: the v1 controller
  the owner's agents stay on until the copy is verified, so a box enrolling
  before then takes none of them.

Additive: an older Core never names the table, and never writes the new stop
reason. The downgrade refuses while any move is unfinished (a row not yet
`done`, `rolled_back` or `cleaned`) or any machine is frozen for one: it
would drop the record a rollback needs. Finish or roll them back first.

Revision ID: c118ea00053c
Revises: 7578dcab9d39
Create Date: 2026-11-10 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c118ea00053c"
down_revision: str | Sequence[str] | None = "7578dcab9d39"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_OLD = (
    "stop_reason IS NULL OR stop_reason IN "
    "('idle', 'owner', 'paused', 'turned_off', 'admin')"
)
_NEW = (
    "stop_reason IS NULL OR stop_reason IN "
    "('idle', 'owner', 'paused', 'turned_off', 'admin', 'migration')"
)
_STEPS = (
    "step IN ('freezing', 'frozen', 'snapshot', 'flipped', 'holding', 'held', "
    "'copy_failed', 'copied', 'released', 'done', 'rolled_back', 'cleaned')"
)


def upgrade() -> None:
    op.create_table(
        "hosted_migrations",
        sa.Column(
            "owner_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "machine_id",
            sa.Text(),
            sa.ForeignKey("cloud_machines.id"),
            nullable=False,
        ),
        sa.Column("step", sa.Text(), nullable=False),
        sa.Column("v1_instance_id", sa.Text(), nullable=True),
        sa.Column("v1_data_volume_id", sa.Text(), nullable=True),
        sa.Column("v1_instance_type", sa.Text(), nullable=True),
        sa.Column("snapshot_id", sa.Text(), nullable=True),
        sa.Column("files_copied", sa.Integer(), nullable=True),
        sa.Column("bytes_copied", sa.BigInteger(), nullable=True),
        sa.Column("symlinks_skipped", sa.Integer(), nullable=True),
        sa.Column("copy_refused", sa.Integer(), nullable=True),
        sa.Column("copy_seconds", sa.Integer(), nullable=True),
        sa.Column("copy_source_volume_id", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(_STEPS, name="ck_hosted_migration_step"),
    )
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _NEW)
    op.add_column(
        "machine_workspaces",
        sa.Column("moving_from_controller_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    connection = op.get_bind()
    unfinished = connection.execute(
        sa.text(
            "SELECT (SELECT count(*) FROM hosted_migrations"
            "    WHERE step NOT IN ('done', 'rolled_back', 'cleaned'))"
            " + (SELECT count(*) FROM cloud_machines WHERE stop_reason = 'migration')"
            " + (SELECT count(*) FROM machine_workspaces"
            "    WHERE moving_from_controller_id IS NOT NULL)"
        )
    ).scalar_one()
    if unfinished:
        raise RuntimeError(
            f"Refusing to downgrade: {unfinished} unfinished hosted migrations or "
            "machines frozen for one. Downgrading would drop what a rollback needs. "
            "Finish or roll them back first."
        )
    op.drop_column("machine_workspaces", "moving_from_controller_id")
    op.drop_constraint("ck_cloud_machine_stop_reason", "cloud_machines", type_="check")
    op.create_check_constraint("ck_cloud_machine_stop_reason", "cloud_machines", _OLD)
    op.drop_table("hosted_migrations")
