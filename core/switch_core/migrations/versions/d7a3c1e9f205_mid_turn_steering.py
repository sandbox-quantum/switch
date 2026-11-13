"""mid-turn steering: the per-agent setting, delivery labels and markers

A message sent while an agent is working can now reach the running turn
(steering). Three pieces of state come with it:

- `agents.mid_turn_delivery`: the owner's choice, "steer" (the default) or
  "queue". A column of its own rather than a key in `agents.metadata`, which
  re-registration replaces whole.
- `session_activity_items.delivery`: on a user message sent mid-turn,
  "steered" or "queued", so every platform's card can say which.
- `steered_message_marks`: the work marker on a steered message, which has no
  turn of its own and so no `turn_status_posts` row to carry one.

Expand only: a release from before this revision never names any of it.

**On locking.** `agents` gains a column with a constant default, a catalog
change only. Its check constraint, and the one on `session_activity_items`
(which every pod writes), are added `NOT VALID`, skipping the scan: every
existing row holds the default or null, which satisfies them, and Postgres
enforces them on every row written from then on. Revisions run in one
transaction, so validating here would scan under this revision's lock;
`VALIDATE CONSTRAINT` is left to a later release.

Revision ID: d7a3c1e9f205
Revises: c8e4a1f7d392
Create Date: 2026-11-13 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d7a3c1e9f205"
down_revision: str | Sequence[str] | None = "c8e4a1f7d392"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column(
            "mid_turn_delivery",
            sa.Text(),
            server_default="steer",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        "ck_agents_mid_turn_delivery",
        "agents",
        "mid_turn_delivery IN ('steer', 'queue')",
        postgresql_not_valid=True,
    )
    op.add_column(
        "session_activity_items", sa.Column("delivery", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_session_activity_items_delivery",
        "session_activity_items",
        "delivery IS NULL OR (kind = 'user-message' "
        "AND delivery IN ('steered', 'queued'))",
        postgresql_not_valid=True,
    )
    op.create_table(
        "steered_message_marks",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("turn_id", sa.Text(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("external_channel_id", sa.Text(), nullable=False),
        sa.Column("reaction_message_ref", sa.Text(), nullable=False),
        sa.Column("marked", sa.Boolean(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_steered_message_marks_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_steered_message_marks_bridge",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_steered_message_marks_agent",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id",
            "bridge_id",
            "agent_id",
            "session_id",
            "turn_id",
            "message_id",
        ),
    )
    op.execute("ALTER TABLE steered_message_marks ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="steered_message_marks"))


def downgrade() -> None:
    op.drop_table("steered_message_marks")
    op.drop_constraint(
        "ck_session_activity_items_delivery", "session_activity_items", type_="check"
    )
    op.drop_column("session_activity_items", "delivery")
    op.drop_constraint("ck_agents_mid_turn_delivery", "agents", type_="check")
    op.drop_column("agents", "mid_turn_delivery")
