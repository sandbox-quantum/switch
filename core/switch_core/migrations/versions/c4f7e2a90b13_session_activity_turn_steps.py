"""Session activity as turn steps, and requests that can be questions

Revision ID: c4f7e2a90b13
Revises: b9e4d2a71c05
Create Date: 2026-09-24

Messaging platforms draw each turn step by step again, so what a host reports
is one row per turn step (the turn itself, its messages, tool calls and
notices) rather than short activity lines, and a request it opens can be a set
of questions as well as an approval. The post tables gain what the platforms'
display keeps track of: removed and unconfirmed cards, the working/queued
marker and the stuck-turn message.

The activity lines are dropped rather than converted: they carry no turn step
to rebuild, and they were pruned after seven days anyway. Approval requests
are kept; one reported before requests named their turn carries an empty
`turn_id` and is drawn outside any turn.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4f7e2a90b13"
down_revision: str | None = "b9e4d2a71c05"
branch_labels = None
depends_on = None

_POLICY = (
    "CREATE POLICY tenant_isolation ON {table} FOR ALL "
    "USING (tenant_id = (SELECT require_tenant_id())) "
    "WITH CHECK (tenant_id = (SELECT require_tenant_id()))"
)


def upgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS session_activity_events_notify ON session_activity_events"
    )
    op.drop_table("session_activity_events")

    op.alter_column("approval_requests", "question", new_column_name="title")
    op.add_column(
        "approval_requests",
        sa.Column("turn_id", sa.Text(), server_default="", nullable=False),
    )
    op.add_column(
        "approval_requests",
        sa.Column("kind", sa.Text(), server_default="approval", nullable=False),
    )
    op.add_column("approval_requests", sa.Column("detail", sa.Text(), nullable=True))
    op.add_column(
        "approval_requests",
        sa.Column("questions", postgresql.JSONB(), server_default="[]", nullable=False),
    )
    op.add_column(
        "approval_requests", sa.Column("answers", postgresql.JSONB(), nullable=True)
    )
    for column in ("turn_id", "kind", "questions"):
        op.alter_column("approval_requests", column, server_default=None)
    op.create_check_constraint(
        "ck_approval_requests_kind",
        "approval_requests",
        "kind IN ('approval', 'questions')",
    )

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
    op.execute(_ITEMS_TRIGGER)

    op.add_column(
        "approval_request_posts",
        sa.Column("removed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "approval_request_posts",
        sa.Column("unconfirmed_notice_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.drop_column("turn_status_posts", "tool_calls")
    op.drop_column("turn_status_posts", "finished")
    op.add_column(
        "turn_status_posts", sa.Column("reaction_message_ref", sa.Text(), nullable=True)
    )
    op.add_column("turn_status_posts", sa.Column("mark", sa.Text(), nullable=True))
    op.add_column(
        "turn_status_posts", sa.Column("attention_post_id", sa.Text(), nullable=True)
    )
    op.create_check_constraint(
        "ck_turn_status_posts_mark",
        "turn_status_posts",
        "mark IN ('queued', 'working')",
    )


def downgrade() -> None:
    raise RuntimeError(
        "c4f7e2a90b13 replaced session activity lines with turn steps and dropped "
        "the lines; restore a backup taken before it to go back."
    )


# Frozen copy of `switch_core.db.session_activity_notify_ddl` as of this
# revision; the live module may change later, this migration must not.
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

_ITEMS_TRIGGER = """
CREATE TRIGGER session_activity_items_notify
    AFTER INSERT OR UPDATE ON session_activity_items
    FOR EACH ROW EXECUTE FUNCTION switch_notify_session_activity()
"""
