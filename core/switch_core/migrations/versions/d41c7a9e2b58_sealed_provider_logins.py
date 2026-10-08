"""agent management: provider logins sealed to a controller

`sealed_provider_logins` holds, per controller and provider, a login the
owner's client sealed to that controller's own public key before sending it:
Switch keeps and relays the ciphertext and cannot open it. Tenant-scoped,
removed with its controller.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Revision ID: d41c7a9e2b58
Revises: fabf9b9bff78
Create Date: 2026-10-08 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d41c7a9e2b58"
down_revision: str | None = "fabf9b9bff78"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "sealed_provider_logins"
_PREDICATE = '"tenant_id" = (SELECT require_tenant_id())'


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("controller_id", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("sealed", postgresql.JSONB(), nullable=False),
        sa.Column("sealed_by", sa.Text(), nullable=False),
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
        sa.PrimaryKeyConstraint("controller_id", "provider"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_sealed_provider_logins_tenant"
        ),
        sa.ForeignKeyConstraint(["sealed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "controller_id"],
            ["agent_controllers.tenant_id", "agent_controllers.id"],
            name="fk_sealed_provider_logins_controller",
            ondelete="CASCADE",
        ),
    )
    op.create_index("ix_sealed_provider_logins_tenant_id", TABLE, ["tenant_id"])
    op.execute(f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY')
    op.execute(
        f'CREATE POLICY tenant_isolation ON "{TABLE}"\n'
        f"    FOR ALL\n"
        f"    USING ({_PREDICATE})\n"
        f"    WITH CHECK ({_PREDICATE})"
    )


def downgrade() -> None:
    op.drop_index("ix_sealed_provider_logins_tenant_id", table_name=TABLE)
    op.drop_table(TABLE)
