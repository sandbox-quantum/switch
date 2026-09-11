"""messaging_install_states

The other half of an install: the in-flight record that ties the operator who
started one to the callback that finishes it. `messaging_installs` is the
result; this is the ticket.

It installs no lookup, and that is the interesting thing about it. The
callback is as unauthenticated as the webhook is, so the obvious shape would
have been a ninth `SECURITY DEFINER` function resolving a state to its tenant
— exactly `tenant_of_api_key`'s shape, an opaque credential presented by a
stranger. It is not needed: the `state` parameter is a token we signed, so the
tenant travels inside it and the callback can bind before it reads. The row
exists for the one thing a signature cannot do, which is to stop being valid
the second time it is presented.

So redemption is an ordinary scoped write — set `consumed_at` where it is
still null, in one statement, and take the absence of a returned row as the
refusal. Row-level security then checks the signature's claim a second time
for free: a token naming the wrong tenant matches no row.

The `tenant_isolation` policy is written out below rather than inherited,
because `265ed188ad6f` installed the policies as they stood then and a table
added afterwards has to bring its own. The DDL is a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written,
copied rather than imported for the reason every revision in this chain
copies: a migration records a change that already happened, and importing the
live module would let a later edit silently change what this one means.
`tests/switch_core/db/test_frozen_ddl_matches_create_all.py` is what keeps the
copy from drifting.

Revision ID: d3f6b0c95a17
Revises: c8a4e21f6d30
Create Date: 2026-09-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3f6b0c95a17"
down_revision: str | None = "c8a4e21f6d30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "messaging_install_states"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("platform", sa.Text(), nullable=False),
        sa.Column("created_by_user_id", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_messaging_install_states_tenant"
        ),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"]),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
