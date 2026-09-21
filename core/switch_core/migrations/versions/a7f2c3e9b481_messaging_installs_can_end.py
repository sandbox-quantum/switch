"""an install that can end, and a workspace that can be installed again

`c8a4e21f6d30` gave `messaging_installs` a plain unique constraint on
`(platform, external_workspace_id)`, on the grounds that a workspace claimed
by two tenants is an event with two destinations. That grounds is still right;
the constraint was too strong for it. It made a claim permanent — the row it
protects is never deleted, so a customer who removed the Switch app from their
own Slack could not put it back, and the error they got told them to "remove
the existing install" through a path that did not exist.

What actually has to be unique is the set of installs that are *serving*. So
the constraint becomes a unique index over `status = 'active'` under the same
name, and ending an install frees the workspace while keeping the record of
what happened to it.

`tenant_of_messaging_install` is redefined against the same predicate, and
that is not a tidy-up. The function resolves a workspace to a tenant for
traffic nobody has authenticated, and it was written to rely on the old
constraint answering at most once. Left alone, the first workspace to be
installed twice would make it answer twice and the caller refuses an ambiguous
answer — so the customer's live install would stop receiving events because of
one they had themselves ended.

Two column changes come with it. `ended_at` records when, alongside the
`status` that says which of the two ways. And `encrypted_bot_token` becomes
nullable so an ended install can keep its record without keeping its secret:
the token is dead by then, and a dead credential still reads like a credential
to whoever finds the dump.

The lookup DDL below is a verbatim copy of `switch_core/db/tenant_lookup.py`
as it stood when this migration was written, copied rather than imported for
the reason every revision in this chain copies: a migration records a change
that already happened, and importing the live module would let a later edit
silently change what this one means.
`tests/switch_core/db/test_frozen_ddl_matches_create_all.py` is what keeps the
copy from drifting.

Revision ID: a7f2c3e9b481
Revises: d3f6b0c95a17
Create Date: 2026-09-15 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7f2c3e9b481"
down_revision: str | None = "d3f6b0c95a17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "messaging_installs"
INDEX_NAME = "uq_messaging_installs_workspace"

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_MESSAGING_INSTALL = f"""CREATE OR REPLACE FUNCTION tenant_of_messaging_install(p_platform text, p_external_workspace_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM messaging_installs WHERE platform = p_platform AND external_workspace_id = p_external_workspace_id AND status = 'active'$$"""

RESTORE_TENANT_OF_MESSAGING_INSTALL = f"""CREATE OR REPLACE FUNCTION tenant_of_messaging_install(p_platform text, p_external_workspace_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM messaging_installs WHERE platform = p_platform AND external_workspace_id = p_external_workspace_id$$"""


def upgrade() -> None:
    # Same name as the constraint it replaces, deliberately: the store reads
    # the name out of the integrity error to tell a claimed workspace from any
    # other write that failed, and Postgres reports a unique index by the same
    # name a unique constraint would have carried.
    op.drop_constraint(INDEX_NAME, TABLE, type_="unique")
    op.create_index(
        INDEX_NAME,
        TABLE,
        ["platform", "external_workspace_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.add_column(
        TABLE, sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.alter_column(
        TABLE, "encrypted_bot_token", existing_type=sa.Text(), nullable=True
    )
    op.execute(CREATE_TENANT_OF_MESSAGING_INSTALL)


def downgrade() -> None:
    op.execute(RESTORE_TENANT_OF_MESSAGING_INSTALL)
    op.alter_column(
        TABLE, "encrypted_bot_token", existing_type=sa.Text(), nullable=False
    )
    op.drop_column(TABLE, "ended_at")
    op.drop_index(INDEX_NAME, table_name=TABLE)
    # Both of the statements above and this one fail on data the old schema
    # cannot hold: an ended install whose token was discarded, and a workspace
    # holding more than one row. That is the honest outcome — going back means
    # choosing which of those installs survives, and a migration is not the
    # thing that gets to choose.
    op.create_unique_constraint(
        INDEX_NAME, TABLE, ["platform", "external_workspace_id"]
    )
