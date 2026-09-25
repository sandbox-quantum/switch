"""Capture a hosted deployment's server-side session state before it is dropped.

A database with hosted launches still has #538's `sdk_*` tables here. What
they hold for hosted agents is copied into `hosted_cutover_items`, and each
launch gets a `hosted_cutover_volumes` row the worker completes with its own
manifest. `b9e4d2a71c05` must run after this revision on such a database, so
a database whose launches outlived those tables is refused rather than
recorded as having nothing to carry over.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "a3c9e5f71d28"
down_revision = "95fc38e451b6"
branch_labels = None
depends_on = None

_HOSTED_AGENTS = """
    SELECT DISTINCT ON (tenant_id, agent_id) tenant_id, agent_id, id AS launch_id
    FROM hosted_launches
    WHERE agent_id IS NOT NULL AND state NOT IN ('deleting', 'deleted')
    ORDER BY tenant_id, agent_id, created_at DESC
"""


def _rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON {table} FOR ALL USING (tenant_id = (SELECT require_tenant_id())) WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
    )


def upgrade() -> None:
    op.create_table(
        "hosted_cutover_volumes",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_hosted_cutover_volumes_tenant"),
            nullable=False,
        ),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column(
            "preflight_state", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column("manifest_sha256", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("tenant_id", "launch_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "preflight_state IN ('pending', 'complete')",
            name="ck_hosted_cutover_volumes_state",
        ),
    )
    _rls("hosted_cutover_volumes")
    op.create_table(
        "hosted_cutover_items",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_hosted_cutover_items_tenant"),
            nullable=False,
        ),
        sa.Column(
            "id",
            sa.Text(),
            nullable=False,
            server_default=sa.text("gen_random_uuid()::text"),
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("launch_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=True),
        sa.Column("message_id", sa.Text(), nullable=True),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("evidence", JSONB(), nullable=False),
        sa.Column("disposition", sa.Text(), nullable=True),
        sa.Column("payload", JSONB(), nullable=True),
        sa.Column("notice_posted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", "id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "launch_id"],
            ["hosted_launches.tenant_id", "hosted_launches.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "kind IN ('room_message', 'console_command', 'session', 'request_open', 'reset_pending', 'operation')",
            name="ck_hosted_cutover_items_kind",
        ),
        sa.CheckConstraint(
            "disposition IS NULL OR disposition IN ('ran', 'uncertain', 'unrecoverable', 'import', 'settled_by_host', 'owner_notice', 'interrupted', 'preserved')",
            name="ck_hosted_cutover_items_disposition",
        ),
        sa.CheckConstraint(
            "kind <> 'room_message' OR (room_id IS NOT NULL AND message_id IS NOT NULL)",
            name="ck_hosted_cutover_items_room_message",
        ),
    )
    op.create_index(
        "uq_hosted_cutover_items_room_message",
        "hosted_cutover_items",
        ["tenant_id", "agent_id", "room_id", "message_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'room_message'"),
    )
    op.create_index(
        "ix_hosted_cutover_items_launch",
        "hosted_cutover_items",
        ["tenant_id", "launch_id"],
    )
    _rls("hosted_cutover_items")

    bind = op.get_bind()
    has_sessions = bind.scalar(
        sa.text("SELECT to_regclass('sdk_sessions') IS NOT NULL")
    )
    launches = bind.scalar(
        sa.text(
            "SELECT count(*) FROM hosted_launches WHERE state NOT IN ('deleting', 'deleted')"
        )
    )
    if not has_sessions:
        if launches:
            raise RuntimeError(
                f"{launches} hosted launches exist but sdk_sessions is already gone, so "
                "their pre-cutover session state cannot be captured. Upgrade with "
                "`switch-hosted-cutover-upgrade` (`just hosted-cutover-upgrade`), "
                "which runs this revision before b9e4d2a71c05."
            )
        return

    op.execute(
        f"""
        INSERT INTO hosted_cutover_volumes (tenant_id, launch_id)
        SELECT tenant_id, launch_id FROM ({_HOSTED_AGENTS}) hosted
        """
    )
    op.execute(
        f"""
        INSERT INTO hosted_cutover_items
            (tenant_id, agent_id, launch_id, session_id, kind, room_id, message_id, thread_id, evidence)
        SELECT DISTINCT ON (c.tenant_id, s.agent_id, c.command->'origin'->>'roomId', c.command->'origin'->>'messageId')
            c.tenant_id, s.agent_id, h.launch_id, c.session_id, 'room_message',
            c.command->'origin'->>'roomId', c.command->'origin'->>'messageId',
            c.command->'origin'->>'threadId',
            jsonb_build_object('core', jsonb_build_object(
                'command_id', c.command_id, 'status', c.status->>'status', 'code', c.status->>'code'))
        FROM sdk_session_commands c
        JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE c.command->'body'->>'type' = 'message.send'
          AND c.command->'origin'->>'roomId' IS NOT NULL
          AND c.command->'origin'->>'messageId' IS NOT NULL
        ORDER BY c.tenant_id, s.agent_id, c.command->'origin'->>'roomId',
                 c.command->'origin'->>'messageId', c.accepted_sequence DESC
        """
    )
    op.execute(
        f"""
        INSERT INTO hosted_cutover_items
            (tenant_id, agent_id, launch_id, session_id, kind, evidence)
        SELECT c.tenant_id, s.agent_id, h.launch_id, c.session_id, 'console_command',
            jsonb_build_object('core', jsonb_build_object(
                'command_id', c.command_id, 'status', c.status->>'status'))
        FROM sdk_session_commands c
        JOIN sdk_sessions s ON s.tenant_id = c.tenant_id AND s.id = c.session_id
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE c.command->'origin'->>'surface' = 'console'
          AND c.command->'origin'->>'roomId' IS NULL
          AND c.status->>'status' = 'accepted'
        """
    )
    op.execute(
        f"""
        INSERT INTO hosted_cutover_items
            (tenant_id, agent_id, launch_id, session_id, kind, evidence)
        SELECT s.tenant_id, s.agent_id, h.launch_id, s.id, 'session',
            jsonb_build_object('core', jsonb_build_object(
                'epoch', s.epoch, 'host_id', s.host_id,
                'lease_expires_at', s.lease_expires_at, 'host_sequence', s.host_sequence))
        FROM sdk_sessions s
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        """
    )
    op.execute(
        f"""
        INSERT INTO hosted_cutover_items
            (tenant_id, agent_id, launch_id, session_id, kind, room_id, thread_id, evidence)
        SELECT p.tenant_id, s.agent_id, h.launch_id, p.session_id, 'request_open',
            p.room_id, p.thread_id,
            jsonb_build_object('core', jsonb_build_object(
                'request_id', p.request_id, 'epoch', p.epoch))
        FROM session_request_posts p
        JOIN sdk_sessions s ON s.tenant_id = p.tenant_id AND s.id = p.session_id
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = s.tenant_id AND h.agent_id = s.agent_id
        WHERE p.removed_at IS NULL AND p.room_id IS NOT NULL
        """
    )
    op.execute(
        f"""
        INSERT INTO hosted_cutover_items
            (tenant_id, agent_id, launch_id, session_id, kind, evidence)
        SELECT o.tenant_id, h.agent_id, o.launch_id, o.session_id, 'operation',
            jsonb_build_object('core', jsonb_build_object(
                'operation_id', o.id, 'action', o.action, 'state', o.state))
        FROM hosted_operations o
        JOIN ({_HOSTED_AGENTS}) h ON h.tenant_id = o.tenant_id AND h.launch_id = o.launch_id
        WHERE o.state IN ('queued', 'claimed')
        """
    )


def downgrade() -> None:
    op.drop_table("hosted_cutover_items")
    op.drop_table("hosted_cutover_volumes")
