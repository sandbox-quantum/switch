"""add room_schedules table for scheduled messages to agents

Revision ID: e7710a1b2c3d
Revises: c7715ebb95c9
Create Date: 2026-10-23 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "e7710a1b2c3d"
down_revision: str | Sequence[str] | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_POLICY = (
    "CREATE POLICY tenant_isolation ON room_schedules FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def upgrade() -> None:
    op.create_table(
        "room_schedules",
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_room_schedules_tenant"),
            nullable=False,
        ),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("target_agent_ids", postgresql.JSONB(), nullable=False),
        sa.Column(
            "schedule_type",
            sa.Text(),
            server_default="recurring",
            nullable=False,
        ),
        sa.Column("cron_expression", sa.Text(), nullable=True),
        sa.Column(
            "timezone",
            sa.Text(),
            server_default="UTC",
            nullable=False,
        ),
        sa.Column(
            "next_run_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "last_run_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.Text(),
            server_default="active",
            nullable=False,
        ),
        sa.Column(
            "missed_run_policy",
            sa.Text(),
            server_default="run_once",
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("id", "tenant_id", name="uq_room_schedules_id_tenant"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_schedules_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            name="fk_room_schedules_created_by_user",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "status IN ('active', 'paused', 'completed')",
            name="ck_room_schedules_status",
        ),
        sa.CheckConstraint(
            "schedule_type IN ('recurring', 'one_off')",
            name="ck_room_schedules_schedule_type",
        ),
        sa.CheckConstraint(
            "missed_run_policy IN ('run_once', 'skip')",
            name="ck_room_schedules_missed_run_policy",
        ),
    )

    op.create_index(
        "ix_room_schedules_next_run",
        "room_schedules",
        ["status", "next_run_at"],
    )
    op.create_index(
        "ix_room_schedules_room_id",
        "room_schedules",
        ["room_id"],
    )
    op.create_index(
        "ix_room_schedules_tenant_id",
        "room_schedules",
        ["tenant_id"],
    )

    op.execute("ALTER TABLE room_schedules ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY)


def downgrade() -> None:
    op.drop_table("room_schedules")
