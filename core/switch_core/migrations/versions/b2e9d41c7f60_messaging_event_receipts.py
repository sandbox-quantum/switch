"""messaging_event_receipts

A platform that retries is a platform that will eventually deliver the same
event twice, and the visible failure is an agent answering one question twice
in a customer's channel. This table is what makes the second delivery cheap to
recognise: a row is written before the work starts, the unique index arbitrates
between concurrent retries, and the loser stops.

`received_at` carries an index of its own because pruning reads that column and
nothing else. Receipts are only interesting for as long as the platform might
still re-send, and without a sweep the table would grow with every message the
busiest workspace ever sends.

The `tenant_isolation` policy is written out below rather than inherited,
because `265ed188ad6f` installed the policies as they stood then and a table
added afterwards has to bring its own. The DDL is a verbatim copy of
`switch_core/db/rls_ddl.py` as it stood when this migration was written,
copied rather than imported for the reason every revision in this chain
copies: a migration records a change that already happened, and importing the
live module would let a later edit silently change what this one means.
`tests/switch_core/db/test_frozen_ddl_matches_create_all.py` is what keeps the
copy from drifting.

Revision ID: b2e9d41c7f60
Revises: a7f2c3e9b481
Create Date: 2026-09-15 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b2e9d41c7f60"
down_revision: str | None = "a7f2c3e9b481"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "messaging_event_receipts"
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
        sa.Column("external_event_id", sa.Text(), nullable=False),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_messaging_event_receipts_tenant"
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "platform",
            "external_event_id",
            name="uq_messaging_event_receipts_event",
        ),
    )
    op.create_index("ix_messaging_event_receipts_received_at", TABLE, ["received_at"])
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)


def downgrade() -> None:
    op.execute(DROP_POLICY)
    op.drop_index("ix_messaging_event_receipts_received_at", table_name=TABLE)
    op.drop_table(TABLE)
