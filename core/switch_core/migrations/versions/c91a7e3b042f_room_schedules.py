"""Durable room schedules and their firing receipts.

Expand only. A firing and its room message commit together.
DDL is frozen here so future model edits do not change migration history.
"""

from alembic import op

revision = "c91a7e3b042f"
down_revision = "a3d9f6c2b871"
branch_labels = None
depends_on = None
expand_only = True


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE room_schedules (
            id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            body TEXT NOT NULL,
            cron TEXT,
            timezone TEXT NOT NULL,
            next_run_at TIMESTAMP WITH TIME ZONE,
            paused BOOLEAN DEFAULT 'false' NOT NULL,
            last_error TEXT,
            tenant_id TEXT NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_room_schedules_tenant_id UNIQUE (tenant_id, id),
            CONSTRAINT fk_room_schedules_room FOREIGN KEY(room_id, tenant_id) REFERENCES rooms (id, tenant_id) ON DELETE CASCADE,
            CONSTRAINT ck_room_schedules_body CHECK (length(trim(body)) > 0),
            FOREIGN KEY(author_id) REFERENCES users (id) ON DELETE CASCADE,
            CONSTRAINT fk_room_schedules_tenant FOREIGN KEY(tenant_id) REFERENCES tenants (id)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_room_schedules_due ON room_schedules (tenant_id, next_run_at) WHERE NOT paused"
    )
    op.execute('ALTER TABLE "room_schedules" ENABLE ROW LEVEL SECURITY')
    op.execute(
        """
        CREATE POLICY tenant_isolation ON "room_schedules"
            FOR ALL
            USING ("tenant_id" = (SELECT require_tenant_id()))
            WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))
        """
    )
    op.execute(
        """
        CREATE TABLE room_schedule_targets (
            schedule_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            PRIMARY KEY (schedule_id, agent_id),
            CONSTRAINT fk_room_schedule_targets_schedule FOREIGN KEY(tenant_id, schedule_id) REFERENCES room_schedules (tenant_id, id) ON DELETE CASCADE,
            CONSTRAINT fk_room_schedule_targets_agent FOREIGN KEY(tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE CASCADE,
            CONSTRAINT fk_room_schedule_targets_tenant FOREIGN KEY(tenant_id) REFERENCES tenants (id)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_room_schedule_targets_tenant_schedule ON room_schedule_targets (tenant_id, schedule_id)"
    )
    op.execute('ALTER TABLE "room_schedule_targets" ENABLE ROW LEVEL SECURITY')
    op.execute(
        """
        CREATE POLICY tenant_isolation ON "room_schedule_targets"
            FOR ALL
            USING ("tenant_id" = (SELECT require_tenant_id()))
            WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))
        """
    )
    op.execute(
        """
        CREATE TABLE room_schedule_runs (
            id TEXT NOT NULL,
            schedule_id TEXT NOT NULL,
            scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
            message_event_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT fk_room_schedule_runs_schedule FOREIGN KEY(tenant_id, schedule_id) REFERENCES room_schedules (tenant_id, id) ON DELETE CASCADE,
            CONSTRAINT uq_room_schedule_runs_occurrence UNIQUE (schedule_id, scheduled_for),
            CONSTRAINT fk_room_schedule_runs_tenant FOREIGN KEY(tenant_id) REFERENCES tenants (id)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_room_schedule_runs_tenant_schedule ON room_schedule_runs (tenant_id, schedule_id)"
    )
    op.execute('ALTER TABLE "room_schedule_runs" ENABLE ROW LEVEL SECURITY')
    op.execute(
        """
        CREATE POLICY tenant_isolation ON "room_schedule_runs"
            FOR ALL
            USING ("tenant_id" = (SELECT require_tenant_id()))
            WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))
        """
    )


def downgrade() -> None:
    op.drop_table("room_schedule_runs")
    op.drop_table("room_schedule_targets")
    op.drop_table("room_schedules")
