"""organization connector apps and service settings

Two organization-scoped tables, each with the policy every
organization-scoped table carries (`db/rls_ddl.py`), compared against the
`require_organization_id()` function `238c68b7306e` created:

- `organization_app_credentials`: the app an organization registered at a
  service's vendor (a GitHub App, a static OAuth client), in the shape of
  `service_app_credentials`, its secrets encrypted with the keyring.
- `organization_service_settings`: a service an organization switched on or
  off for its workspaces, and whether that is locked.

`updated_by` on both is cleared when the account is deleted.

And the fifteenth lookup exempt from row-level security,
`all_organization_ids()`, so the boot's key rotation reaches every
organization directly. See `db/tenant_lookup.py` for what it discloses.

The policy and function DDL are verbatim copies of `switch_core/db/rls_ddl.py`
and `switch_core/db/tenant_lookup.py` as they stood
when this migration was written, copied rather than imported for the reason
`265ed188ad6f` gives.

Expand only: a process from before this revision never reads the tables.

Revision ID: 10f6d02ac5bc
Revises: 9d41b7e2c6a3
Create Date: 2026-10-30 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "10f6d02ac5bc"
down_revision: str | Sequence[str] | None = "9d41b7e2c6a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_ORGANIZATION_FUNCTION_NAME = "require_organization_id"
ORGANIZATION_POLICY_NAME = "organization_isolation"
_PREDICATE = f'"organization_id" = (SELECT {REQUIRE_ORGANIZATION_FUNCTION_NAME}())'
_TABLES = ("organization_app_credentials", "organization_service_settings")
SECURE_SEARCH_PATH = "pg_catalog, public, pg_temp"

CREATE_ALL_ORGANIZATION_IDS = f"""CREATE OR REPLACE FUNCTION all_organization_ids()
    RETURNS SETOF text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = {SECURE_SEARCH_PATH}
AS $$SELECT id FROM organizations ORDER BY created_at, id$$"""

DROP_ALL_ORGANIZATION_IDS = "DROP FUNCTION IF EXISTS all_organization_ids()"


def _timestamp(name: str) -> sa.Column:
    return sa.Column(
        name,
        sa.DateTime(timezone=True),
        server_default=sa.text("now()"),
        nullable=False,
    )


def _organization(table: str) -> list[sa.Column | sa.Constraint]:
    return [
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name=f"fk_{table}_organization",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=f"fk_{table}_updated_by",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("organization_id", "service"),
    ]


def upgrade() -> None:
    op.create_table(
        "organization_app_credentials",
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("settings", postgresql.JSONB(), nullable=False),
        sa.Column("encrypted_secrets", sa.Text(), nullable=False),
        _timestamp("updated_at"),
        _timestamp("created_at"),
        *_organization("organization_app_credentials"),
    )
    op.create_table(
        "organization_service_settings",
        sa.Column("service", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("locked", sa.Boolean(), nullable=False),
        _timestamp("updated_at"),
        *_organization("organization_service_settings"),
    )
    for table in _TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(
            f'CREATE POLICY {ORGANIZATION_POLICY_NAME} ON "{table}"\n'
            f"    FOR ALL\n"
            f"    USING ({_PREDICATE})\n"
            f"    WITH CHECK ({_PREDICATE})"
        )
    op.execute(CREATE_ALL_ORGANIZATION_IDS)


def downgrade() -> None:
    op.execute(DROP_ALL_ORGANIZATION_IDS)
    for table in reversed(_TABLES):
        op.execute(f'DROP POLICY IF EXISTS {ORGANIZATION_POLICY_NAME} ON "{table}"')
        op.drop_table(table)
