"""Session activity and approval requests, reported by the session's host

Revision ID: 545f80e11f13
Revises: 4d18ba7c6f31
Create Date: 2026-09-23

A session and its transcript belong to the host that runs it. What the server
needs is far smaller: each turn's steps as a messaging platform draws them, and
the requests a session is waiting on, so an answer given on any platform can be
checked and handed back to the agent. Both are one small row per write.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "545f80e11f13"
down_revision: str | None = "4d18ba7c6f31"
branch_labels = None
depends_on = None

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def upgrade() -> None:
    op.create_table(
        "approval_requests",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_approval_requests_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("turn_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=True),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("options", postgresql.JSONB(), nullable=False),
        sa.Column("questions", postgresql.JSONB(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("answer", sa.Text(), nullable=True),
        sa.Column("answers", postgresql.JSONB(), nullable=True),
        sa.Column("answered_by", sa.Text(), nullable=True),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.PrimaryKeyConstraint("tenant_id", "agent_id", "session_id", "request_id"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_approval_requests_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_approval_requests_room",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "state IN ('open', 'answered', 'expired', 'closed')",
            name="ck_approval_requests_state",
        ),
        sa.CheckConstraint(
            "kind IN ('approval', 'questions')",
            name="ck_approval_requests_kind",
        ),
    )
    op.create_index(
        "ix_approval_requests_open_expiry",
        "approval_requests",
        ["expires_at"],
        postgresql_where=sa.text("state = 'open' AND expires_at IS NOT NULL"),
    )
    op.create_index(
        "ix_approval_requests_undelivered",
        "approval_requests",
        ["tenant_id", "agent_id"],
        postgresql_where=sa.text(
            "state IN ('answered', 'expired') AND delivered_at IS NULL"
        ),
    )
    op.execute("ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="approval_requests"))

    op.create_table(
        "session_activity_items",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_session_activity_items_tenant"),
            nullable=False,
        ),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("turn_id", sa.Text(), nullable=False),
        sa.Column("item_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("command_id", sa.Text(), nullable=True),
        sa.Column("room_id", sa.Text(), nullable=True),
        sa.Column("thread_id", sa.Text(), nullable=True),
        sa.Column("message_id", sa.Text(), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
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
        sa.PrimaryKeyConstraint(
            "tenant_id", "agent_id", "session_id", "turn_id", "item_id"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_session_activity_items_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_session_activity_items_room",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "kind IN ('turn', 'user-message', 'assistant-message', "
            "'tool-activity', 'notice')",
            name="ck_session_activity_items_kind",
        ),
    )
    op.create_index(
        "ix_session_activity_items_updated_at",
        "session_activity_items",
        ["updated_at"],
    )
    op.execute("ALTER TABLE session_activity_items ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="session_activity_items"))

    op.execute(_NOTIFY_FUNCTION)
    for trigger in _TRIGGERS:
        op.execute(trigger)

    op.create_table(
        "approval_request_posts",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_approval_request_posts_tenant"),
            nullable=False,
        ),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("request_id", sa.Text(), nullable=False),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("handle", sa.Text(), nullable=False),
        sa.Column("external_channel_id", sa.Text(), nullable=False),
        sa.Column("external_post_id", sa.Text(), nullable=True),
        sa.Column("thread_ref", sa.Text(), nullable=True),
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("unconfirmed_notice_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id", "bridge_id", "agent_id", "session_id", "request_id"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_approval_request_posts_bridge",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_approval_request_posts_agent",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("token", name="uq_approval_request_posts_token"),
    )
    op.create_index(
        "uq_approval_request_posts_handle",
        "approval_request_posts",
        ["bridge_id", "external_channel_id", sa.text("lower(handle)")],
        unique=True,
    )
    op.execute("ALTER TABLE approval_request_posts ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="approval_request_posts"))

    op.create_table(
        "turn_status_posts",
        sa.Column(
            "tenant_id",
            sa.Text(),
            sa.ForeignKey("tenants.id", name="fk_turn_status_posts_tenant"),
            nullable=False,
        ),
        sa.Column("bridge_id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("turn_id", sa.Text(), nullable=False),
        sa.Column("external_channel_id", sa.Text(), nullable=False),
        sa.Column("external_post_id", sa.Text(), nullable=False),
        sa.Column("thread_ref", sa.Text(), nullable=True),
        sa.Column("reaction_message_ref", sa.Text(), nullable=True),
        sa.Column("mark", sa.Text(), nullable=True),
        sa.Column("attention_post_id", sa.Text(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id", "bridge_id", "agent_id", "session_id", "turn_id"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_turn_status_posts_bridge",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_turn_status_posts_agent",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "mark IN ('queued', 'working')",
            name="ck_turn_status_posts_mark",
        ),
    )
    op.execute("ALTER TABLE turn_status_posts ENABLE ROW LEVEL SECURITY")
    op.execute(_POLICY.format(table="turn_status_posts"))


def downgrade() -> None:
    op.drop_table("turn_status_posts")
    op.drop_table("approval_request_posts")
    op.drop_table("session_activity_items")
    op.drop_table("approval_requests")
    op.execute("DROP FUNCTION IF EXISTS switch_notify_session_activity()")


# A frozen copy of `db/session_activity_notify_ddl.py` as it stood when this
# migration was written; see that module for why the row rides in the payload.
_NOTIFY_FUNCTION = """
CREATE OR REPLACE FUNCTION switch_notify_session_activity() RETURNS trigger AS $$
DECLARE
    body jsonb := to_jsonb(NEW);
    key jsonb;
    payload text;
BEGIN
    IF TG_TABLE_NAME = 'session_activity_items' THEN
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'key', body->>'turn_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
    ELSE
        key := jsonb_build_object(
            'tenant_id', NEW.tenant_id,
            'agent_id', NEW.agent_id,
            'session_id', NEW.session_id,
            'key', body->>'request_id'
        );
        payload := jsonb_build_object('table', TG_TABLE_NAME, 'row', body)::text;
        IF octet_length(payload) > 7500 THEN
            payload := jsonb_build_object('table', TG_TABLE_NAME, 'key', key)::text;
        END IF;
    END IF;
    PERFORM pg_notify('switch_session_activity', payload);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql
"""

_TRIGGERS = (
    """
CREATE TRIGGER session_activity_items_notify
    AFTER INSERT OR UPDATE ON session_activity_items
    FOR EACH ROW EXECUTE FUNCTION switch_notify_session_activity()
""",
    """
CREATE TRIGGER approval_requests_notify_insert
    AFTER INSERT ON approval_requests
    FOR EACH ROW EXECUTE FUNCTION switch_notify_session_activity()
""",
    """
CREATE TRIGGER approval_requests_notify_state
    AFTER UPDATE OF state ON approval_requests
    FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION switch_notify_session_activity()
""",
)
