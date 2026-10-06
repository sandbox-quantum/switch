"""drop room settings, agent state and tables nothing reads

Every column and table here was written by something, or by nothing, and read
by nothing that changed what Switch does:

- `rooms.protection_config` and `rooms.observe_config`, set from the gateway
  and from `create_room`'s `security_config`, for protection checks and an
  observe pipeline that were never built.
- `rooms.admin_mode`, whose only effect was a line in an agent's room
  instructions promising elevated capabilities that nothing granted.
- `agent_runtime_states`, the last runtime state each agent's session
  reported in a room. No client reports one any more; `!status` and the
  session-control commands read rows nothing wrote.
- `message_exchange`, `pre_invocation_mediation`, `post_invocation_mediation`
  and `event_reporting` in every stored integration profile. Nothing reads
  them, and the mediation and reporting routes they described are gone.
- `delivery_cursors`, a persisted per-agent delivery position no code reads
  or writes.
- `skills`, `agent_skills` and `room_skills`, which nothing ever filled; the
  only code that touched them deleted an agent's rows from them.

The downgrade puts every column back as `dad29005a7f7` created it: the
settings empty, `admin_mode` off. It recreates every table empty, with the
row-level security policy `265ed188ad6f` gave it, so a rollback lands on a
schema the previous revision recognises. No value or row is restored. It puts
the four profile keys back with message exchange on and nothing mediated or
reported, because the code before this revision requires them.

Revision ID: 871623ec1ebf
Revises: 4dcf1747443d
Create Date: 2026-10-06 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "871623ec1ebf"
down_revision: str | None = "4dcf1747443d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _enable_rls(table: str) -> None:
    op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def upgrade() -> None:
    op.drop_column("rooms", "protection_config")
    op.drop_column("rooms", "observe_config")
    op.drop_column("rooms", "admin_mode")
    op.drop_table("agent_runtime_states")
    op.drop_table("delivery_cursors")
    op.drop_table("room_skills")
    op.drop_table("agent_skills")
    op.drop_table("skills")

    op.execute(
        "UPDATE agents SET integration_profile = integration_profile - "
        "ARRAY['message_exchange', 'pre_invocation_mediation', "
        "'post_invocation_mediation', 'event_reporting'] "
        "WHERE integration_profile ?| "
        "ARRAY['message_exchange', 'pre_invocation_mediation', "
        "'post_invocation_mediation', 'event_reporting']"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE agents SET integration_profile = "
        """'{"message_exchange": true, "pre_invocation_mediation": [], """
        """"post_invocation_mediation": [], "event_reporting": []}'::jsonb """
        "|| integration_profile"
    )
    op.create_table(
        "agent_runtime_states",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deeplink_url", sa.Text(), nullable=True),
        sa.Column(
            "control_capabilities",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="agent_runtime_states_pkey"),
        sa.UniqueConstraint(
            "agent_id", "room_id", name="uq_agent_runtime_states_agent_room"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_agent_runtime_states_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_agent_runtime_states_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_agent_runtime_states_tenant"
        ),
    )
    op.create_index(
        "ix_agent_runtime_states_tenant_id", "agent_runtime_states", ["tenant_id"]
    )
    _enable_rls("agent_runtime_states")

    op.create_table(
        "delivery_cursors",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("last_seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="delivery_cursors_pkey"),
        sa.UniqueConstraint(
            "agent_id", "room_id", name="uq_delivery_cursors_agent_room"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_delivery_cursors_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_delivery_cursors_room",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_delivery_cursors_tenant"
        ),
    )
    op.create_index("ix_delivery_cursors_tenant_id", "delivery_cursors", ["tenant_id"])
    _enable_rls("delivery_cursors")

    op.create_table(
        "skills",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("visibility", sa.Text(), nullable=False),
        sa.Column("owner_agent_id", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("package_uri", sa.Text(), nullable=False),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="skills_pkey"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_skills_id_tenant"),
        sa.ForeignKeyConstraint(
            ["tenant_id", "owner_agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_skills_owner_agent",
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], name="fk_skills_tenant"),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="skills_created_by_fkey"
        ),
    )
    op.create_index("ix_skills_tenant_id", "skills", ["tenant_id"])
    _enable_rls("skills")

    for link, other, other_table in (
        ("agent_skills", "agent_id", "agents"),
        ("room_skills", "room_id", "rooms"),
    ):
        op.create_table(
            link,
            sa.Column(other, sa.Text(), nullable=False),
            sa.Column("skill_id", sa.Text(), nullable=False),
            sa.Column("tenant_id", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint(other, "skill_id", name=f"{link}_pkey"),
            sa.ForeignKeyConstraint(
                ["tenant_id", other],
                [f"{other_table}.tenant_id", f"{other_table}.id"],
                name=f"fk_{link}_{other.removesuffix('_id')}",
            ),
            sa.ForeignKeyConstraint(
                ["tenant_id", "skill_id"],
                ["skills.tenant_id", "skills.id"],
                name=f"fk_{link}_skill",
            ),
            sa.ForeignKeyConstraint(
                ["tenant_id"], ["tenants.id"], name=f"fk_{link}_tenant"
            ),
        )
        op.create_index(f"ix_{link}_tenant_id", link, ["tenant_id"])
        _enable_rls(link)

    op.add_column(
        "rooms",
        sa.Column("admin_mode", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "rooms",
        sa.Column(
            "observe_config", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )
    op.add_column(
        "rooms",
        sa.Column(
            "protection_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )
