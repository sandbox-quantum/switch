"""messaging_installs, and the lookup that resolves one to a tenant

The table behind the official Slack app: one row per external workspace a
tenant has installed us into, holding the token that install granted. It is
tenant-scoped like everything else, so it gets the same `tenant_isolation`
policy as the other tables — written out below rather than inherited, because
`265ed188ad6f` installed the policies as they stood then and a table added
afterwards has to bring its own.

`(platform, external_workspace_id)` is unique across the deployment rather
than per tenant. Inbound events arrive over one public endpoint carrying a
workspace id and no tenant, so a workspace claimed twice is an event with two
possible destinations; the constraint makes that unrepresentable, and it has
to be the database that decides because a read-then-insert in application code
cannot be made atomic. It is also globally unique for the same reason
`api_keys.key_hash` is: the value is resolved before a tenant is known, so a
per-tenant index could not answer the question being asked.

`tenant_of_messaging_install(platform, workspace)` is the lookup that asks it,
and it is an addition to the closed set of `SECURITY DEFINER` functions
`9c41a7b0e5d8` installed as the whole exemption from row-level security. That
set is deliberately short and every entry in it is callable by anyone holding
the runtime role's credentials, so adding one is meant to be argued with. The
argument for this one: the webhook is unauthenticated by nature and holds
nothing but a workspace id, the answer it returns is a tenant id and never a
row, and without it there is no way to bind a tenant before touching the
payload — which is the only order in which the payload may be touched at all.

It takes two arguments where every other lookup takes one, because the pair is
what the table makes unique. A lookup on the workspace id alone would answer
twice the first time two platforms minted the same string, and the caller
refuses an ambiguous answer rather than picking — so one customer's traffic
would start failing for a reason in another platform's namespace.

The DDL below is a verbatim copy of `switch_core/db/rls_ddl.py` and
`switch_core/db/tenant_lookup.py` as they stood when this migration was
written, copied rather than imported for the same reason every other revision
in this chain copies rather than imports: a migration is a record of a change
that already happened, and importing the live module would let a later edit
silently change what this one means.
`tests/switch_core/db/test_frozen_ddl_matches_create_all.py` is what keeps the
copy from drifting.

Revision ID: c8a4e21f6d30
Revises: b1d7c4f0a92e
Create Date: 2026-09-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8a4e21f6d30"
down_revision: str | None = "b1d7c4f0a92e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "messaging_installs"
POLICY_NAME = "tenant_isolation"

ENABLE_RLS = f'ALTER TABLE "{TABLE}" ENABLE ROW LEVEL SECURITY'

CREATE_POLICY = f"""CREATE POLICY {POLICY_NAME} ON "{TABLE}"
    FOR ALL
    USING ("tenant_id" = (SELECT require_tenant_id()))
    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))"""

DROP_POLICY = f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{TABLE}"'

SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_TENANT_OF_MESSAGING_INSTALL = f"""CREATE OR REPLACE FUNCTION tenant_of_messaging_install(p_platform text, p_external_workspace_id text)
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT tenant_id FROM messaging_installs WHERE platform = p_platform AND external_workspace_id = p_external_workspace_id$$"""

DROP_TENANT_OF_MESSAGING_INSTALL = (
    "DROP FUNCTION IF EXISTS tenant_of_messaging_install(text, text)"
)


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("platform", sa.Text(), nullable=False),
        sa.Column("external_workspace_id", sa.Text(), nullable=False),
        sa.Column("encrypted_bot_token", sa.Text(), nullable=False),
        sa.Column("scopes", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("installed_by_user_id", sa.Text(), nullable=False),
        sa.Column("bridge_id", sa.Text(), nullable=True),
        sa.Column(
            "installed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_messaging_installs_tenant"
        ),
        sa.ForeignKeyConstraint(["installed_by_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(
            ["tenant_id", "bridge_id"],
            ["collaboration_bridges.tenant_id", "collaboration_bridges.id"],
            name="fk_messaging_installs_bridge",
        ),
        sa.UniqueConstraint(
            "platform", "external_workspace_id", name="uq_messaging_installs_workspace"
        ),
        sa.UniqueConstraint("id", "tenant_id", name="uq_messaging_installs_id_tenant"),
    )
    op.execute(ENABLE_RLS)
    op.execute(CREATE_POLICY)
    op.execute(CREATE_TENANT_OF_MESSAGING_INSTALL)


def downgrade() -> None:
    op.execute(DROP_TENANT_OF_MESSAGING_INSTALL)
    op.execute(DROP_POLICY)
    op.drop_table(TABLE)
