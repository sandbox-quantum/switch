"""room schedules: messages Switch posts to a room's agents on a timer

`room_schedules` holds a room's schedules: the text, the agents it is
addressed to, a cron rule or a single time with its timezone, and when it
runs next. A schedule goes when its room or its author does, and one an agent
set up through its Switch tools goes with that agent.

The `tenant_isolation` policy is written out below rather than inherited,
because `265ed188ad6f` installed the policies as they stood then and a table
added afterwards has to bring its own. The DDL is a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written.

Expand only: a release from before this revision never reads the new table.

Revision ID: c7e2a9d41b63
Revises: 95b5d17f4519
Create Date: 2026-11-04 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7e2a9d41b63"
down_revision: str | None = "95b5d17f4519"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

TABLE = "room_schedules"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'


def upgrade() -> None:
    op.create_table(
        "room_schedules",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_room_schedules_tenant"),
            nullable=False,
        ),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column(
            "author_id",
            sa.Text(),
            sa.ForeignKey(
                "users.id", name="fk_room_schedules_author", ondelete="CASCADE"
            ),
            nullable=False,
        ),
        sa.Column("author_agent_id", sa.Text(), nullable=True),
        sa.Column("agent_ids", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("cron", sa.Text(), nullable=True),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint(
            "(cron IS NULL) <> (run_at IS NULL)", name="room_schedules_one_timing"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_room_schedules_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "author_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_room_schedules_author_agent",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_room_schedules_tenant_id", "room_schedules", ["tenant_id"])
    op.create_index("ix_room_schedules_room_id", "room_schedules", ["room_id"])
    op.create_index("ix_room_schedules_next_run_at", "room_schedules", ["next_run_at"])
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
