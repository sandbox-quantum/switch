"""Scope SDK authority records and attachment addresses to their owning tenant."""

import sqlalchemy as sa
from alembic import op

revision = "c83f6e0a4129"
down_revision = "b72e5d9f3018"
branch_labels = None
depends_on = None

TABLES = ("sdk_sessions", "sdk_session_events", "sdk_session_commands")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column("tenant_id", sa.Text(), nullable=True))
    op.execute(
        "UPDATE sdk_sessions s SET tenant_id = a.tenant_id FROM agents a WHERE a.id = s.agent_id"
    )
    for table in TABLES[1:]:
        op.execute(
            f"UPDATE {table} c SET tenant_id = s.tenant_id FROM sdk_sessions s WHERE s.id = c.session_id"
        )
    for table in TABLES:
        op.alter_column(table, "tenant_id", nullable=False)
        op.create_foreign_key(
            f"fk_{table}_tenant", table, "tenants", ["tenant_id"], ["id"]
        )

    op.drop_constraint("fk_media_blobs_sdk_session", "media_blobs", type_="foreignkey")
    for table in TABLES[1:]:
        op.drop_constraint(f"{table}_session_id_fkey", table, type_="foreignkey")
    op.drop_constraint("sdk_sessions_agent_id_fkey", "sdk_sessions", type_="foreignkey")
    op.drop_constraint("uq_sdk_sessions_connection_id", "sdk_sessions", type_="unique")
    op.drop_constraint(
        "sdk_session_events_session_id_epoch_host_sequence_key",
        "sdk_session_events",
        type_="unique",
    )
    op.drop_constraint(
        "sdk_session_events_session_id_event_id_key",
        "sdk_session_events",
        type_="unique",
    )
    for table, keys in (
        ("sdk_sessions", ["id"]),
        ("sdk_session_events", ["session_id", "sequence"]),
        ("sdk_session_commands", ["session_id", "command_id"]),
    ):
        op.drop_constraint(f"{table}_pkey", table, type_="primary")
        op.create_primary_key(f"{table}_pkey", table, ["tenant_id", *keys])
    op.create_unique_constraint(
        "uq_sdk_sessions_id_tenant", "sdk_sessions", ["id", "tenant_id"]
    )
    op.create_unique_constraint(
        "uq_sdk_sessions_connection_id", "sdk_sessions", ["tenant_id", "connection_id"]
    )
    op.create_unique_constraint(
        "uq_sdk_event_host_sequence",
        "sdk_session_events",
        ["tenant_id", "session_id", "epoch", "host_sequence"],
    )
    op.create_unique_constraint(
        "uq_sdk_event_id", "sdk_session_events", ["tenant_id", "session_id", "event_id"]
    )
    op.create_foreign_key(
        "fk_sdk_sessions_agent",
        "sdk_sessions",
        "agents",
        ["tenant_id", "agent_id"],
        ["tenant_id", "id"],
    )
    for table in TABLES[1:]:
        op.create_foreign_key(
            f"fk_{table}_session",
            table,
            "sdk_sessions",
            ["tenant_id", "session_id"],
            ["tenant_id", "id"],
            ondelete="CASCADE",
        )
    op.create_foreign_key(
        "fk_media_blobs_sdk_session",
        "media_blobs",
        "sdk_sessions",
        ["tenant_id", "sdk_session_id"],
        ["tenant_id", "id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("media_blobs_uri_key", "media_blobs", type_="unique")
    op.create_unique_constraint(
        "uq_media_blobs_tenant_uri", "media_blobs", ["tenant_id", "uri"]
    )
    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(
            f'CREATE POLICY tenant_isolation ON "{table}"\n'
            f"    FOR ALL\n"
            f'    USING ("tenant_id" = (SELECT require_tenant_id()))\n'
            f'    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))'
        )


def downgrade() -> None:
    op.drop_constraint("fk_media_blobs_sdk_session", "media_blobs", type_="foreignkey")
    for table in TABLES[1:]:
        op.drop_constraint(f"fk_{table}_session", table, type_="foreignkey")
    op.drop_constraint("fk_sdk_sessions_agent", "sdk_sessions", type_="foreignkey")
    op.drop_constraint(
        "uq_sdk_event_host_sequence", "sdk_session_events", type_="unique"
    )
    op.drop_constraint("uq_sdk_event_id", "sdk_session_events", type_="unique")
    op.drop_constraint("uq_sdk_sessions_connection_id", "sdk_sessions", type_="unique")
    op.drop_constraint("uq_sdk_sessions_id_tenant", "sdk_sessions", type_="unique")
    for table, keys in (
        ("sdk_sessions", ["id"]),
        ("sdk_session_events", ["session_id", "sequence"]),
        ("sdk_session_commands", ["session_id", "command_id"]),
    ):
        op.drop_constraint(f"{table}_pkey", table, type_="primary")
        op.create_primary_key(f"{table}_pkey", table, keys)
        op.execute(f'DROP POLICY tenant_isolation ON "{table}"')
        op.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
        op.drop_constraint(f"fk_{table}_tenant", table, type_="foreignkey")
        op.drop_column(table, "tenant_id")
    op.create_foreign_key(
        "sdk_sessions_agent_id_fkey", "sdk_sessions", "agents", ["agent_id"], ["id"]
    )
    for table in TABLES[1:]:
        op.create_foreign_key(
            f"{table}_session_id_fkey",
            table,
            "sdk_sessions",
            ["session_id"],
            ["id"],
            ondelete="CASCADE",
        )
    op.create_unique_constraint(
        "uq_sdk_sessions_connection_id", "sdk_sessions", ["connection_id"]
    )
    op.create_unique_constraint(
        "sdk_session_events_session_id_epoch_host_sequence_key",
        "sdk_session_events",
        ["session_id", "epoch", "host_sequence"],
    )
    op.create_unique_constraint(
        "sdk_session_events_session_id_event_id_key",
        "sdk_session_events",
        ["session_id", "event_id"],
    )
    op.create_foreign_key(
        "fk_media_blobs_sdk_session",
        "media_blobs",
        "sdk_sessions",
        ["sdk_session_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint("uq_media_blobs_tenant_uri", "media_blobs", type_="unique")
    op.create_unique_constraint("media_blobs_uri_key", "media_blobs", ["uri"])
