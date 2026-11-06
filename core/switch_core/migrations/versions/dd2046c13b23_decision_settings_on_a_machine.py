"""decision settings: run the decision model on one of the admin's machines

A workspace may choose `machine` as its decision backend: one of its admin's
own agent controllers serves the decision model, and decisions go over that
controller's connection (`decision/machine.py`). Three columns on
`decision_settings`:

- `controller_id`: the machine, an `agent_controllers` row in the same
  workspace. Deleting the controller (its owner's account deleted) deletes
  the setting, so the workspace returns to the server default; a revoked
  controller keeps its row, and the setting reads as removed.
- `model`: the catalogue model the machine serves (`qwen3.5-4b-q4_k_m`).
- `machine_ready_at`: when the machine first reported the model running for
  this setting. Until then auto-route is unavailable there, without notices.

Expand only: a process from before this revision never writes `machine`, and
reads such a row as a backend it does not know (no decisions in that
workspace until it is replaced). The downgrade deletes `machine` rows, which
puts those workspaces back on the server default, before restoring the
narrower check.

Revision ID: dd2046c13b23
Revises: 689d7d8ff913
Create Date: 2026-10-29 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "dd2046c13b23"
down_revision: str | Sequence[str] | None = "689d7d8ff913"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "decision_settings"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("controller_id", sa.Text(), nullable=True))
    op.add_column(TABLE, sa.Column("model", sa.Text(), nullable=True))
    op.add_column(
        TABLE,
        sa.Column("machine_ready_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_constraint("ck_decision_settings_backend", TABLE, type_="check")
    op.create_check_constraint(
        "ck_decision_settings_backend",
        TABLE,
        "backend IN ('none', 'endpoint', 'haiku_anthropic', 'haiku_bedrock', "
        "'machine')",
    )
    op.create_check_constraint(
        "ck_decision_settings_machine",
        TABLE,
        "backend <> 'machine' OR (controller_id IS NOT NULL AND model IS NOT NULL)",
    )
    op.create_foreign_key(
        "fk_decision_settings_controller",
        TABLE,
        "agent_controllers",
        ["tenant_id", "controller_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM \"{TABLE}\" WHERE backend = 'machine'")
    op.drop_constraint("fk_decision_settings_controller", TABLE, type_="foreignkey")
    op.drop_constraint("ck_decision_settings_machine", TABLE, type_="check")
    op.drop_constraint("ck_decision_settings_backend", TABLE, type_="check")
    op.create_check_constraint(
        "ck_decision_settings_backend",
        TABLE,
        "backend IN ('none', 'endpoint', 'haiku_anthropic', 'haiku_bedrock')",
    )
    op.drop_column(TABLE, "machine_ready_at")
    op.drop_column(TABLE, "model")
    op.drop_column(TABLE, "controller_id")
