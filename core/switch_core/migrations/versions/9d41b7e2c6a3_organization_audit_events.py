"""organization audit events: the history of changes to an organization

One organization-scoped table, `organization_audit_events`, with the policy
every organization-scoped table carries (`db/rls_ddl.py`), compared against
the `require_organization_id()` function `238c68b7306e` created. Append-only
for the runtime role as `audit_events` is: the revoke is reissued by
`grant_runtime_role` on every boot.

The policy DDL is a verbatim copy of `switch_core/db/rls_ddl.py` as it stood
when this migration was written, copied rather than imported for the reason
`265ed188ad6f` gives.

Expand only: a process from before this revision never reads the table.

Revision ID: 9d41b7e2c6a3
Revises: 5c2e8f17a9d4
Create Date: 2026-10-29 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9d41b7e2c6a3"
down_revision: str | Sequence[str] | None = "5c2e8f17a9d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_ORGANIZATION_FUNCTION_NAME = "require_organization_id"
ORGANIZATION_POLICY_NAME = "organization_isolation"
_PREDICATE = f'"organization_id" = (SELECT {REQUIRE_ORGANIZATION_FUNCTION_NAME}())'


def upgrade() -> None:
    op.create_table(
        "organization_audit_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.Column("actor_user_id", sa.Text(), nullable=True),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("target_type", sa.Text(), nullable=False),
        sa.Column("target_id", sa.Text(), nullable=True),
        sa.Column("details", postgresql.JSONB(), nullable=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_organization_audit_events_organization",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_organization_audit_events_organization_occurred_at",
        "organization_audit_events",
        ["organization_id", "occurred_at"],
    )
    op.execute('ALTER TABLE "organization_audit_events" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY {ORGANIZATION_POLICY_NAME} ON "organization_audit_events"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def downgrade() -> None:
    op.execute(
        f'DROP POLICY IF EXISTS {ORGANIZATION_POLICY_NAME} ON "organization_audit_events"'
    )
    op.drop_index(
        "ix_organization_audit_events_organization_occurred_at",
        table_name="organization_audit_events",
    )
    op.drop_table("organization_audit_events")
