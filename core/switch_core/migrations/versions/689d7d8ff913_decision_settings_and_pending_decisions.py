"""decision settings per workspace, and decisions that survive a restart

Two tenant-scoped tables for decision routing (`delivery/decision.py`):

- `decision_settings`: a workspace's choice of decision backend, at most one
  row per workspace. No row means the server default from the environment, so
  an upgraded server behaves as before with the table empty.
- `pending_decisions`: a person's message waiting for the decision service,
  written with the message and deleted once it is decided, so a restart does
  not lose it.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Expand only: a process from before this revision never reads either table,
and decides untagged messages in memory, as it always did.

Revision ID: 689d7d8ff913
Revises: b7e1d4c9a2f6
Create Date: 2026-10-27 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "689d7d8ff913"
down_revision: str | Sequence[str] | None = "b7e1d4c9a2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"
SETTINGS = "decision_settings"
PENDING = "pending_decisions"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'


def _create_policy(table: str) -> str:
    return (
        f'CREATE POLICY {POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def upgrade() -> None:
    op.create_table(
        SETTINGS,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("backend", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=True),
        sa.Column("api_key_encrypted", sa.Text(), nullable=True),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("tenant_id", name="pk_decision_settings"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_decision_settings_tenant"
        ),
        sa.CheckConstraint(
            "backend IN ('none', 'endpoint', 'haiku_anthropic', 'haiku_bedrock')",
            name="ck_decision_settings_backend",
        ),
        sa.CheckConstraint(
            "threshold IS NULL OR (threshold >= 0 AND threshold <= 1)",
            name="ck_decision_settings_threshold",
        ),
    )
    op.execute(f'ALTER TABLE "{SETTINGS}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(SETTINGS))

    op.create_table(
        PENDING,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("room_id", sa.Text(), nullable=False),
        sa.Column("room_seq", sa.BigInteger(), nullable=False),
        sa.Column("message_key", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("claimed_until", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint(
            "tenant_id", "room_id", "room_seq", name="pk_pending_decisions"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_pending_decisions_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_pending_decisions_room",
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_pending_decisions_created_at", PENDING, ["tenant_id", "created_at"]
    )
    op.execute(f'ALTER TABLE "{PENDING}" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy(PENDING))


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{PENDING}"')
    op.drop_index("ix_pending_decisions_created_at", table_name=PENDING)
    op.drop_table(PENDING)
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{SETTINGS}"')
    op.drop_table(SETTINGS)
