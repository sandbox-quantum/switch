"""organizations: a customer owning workspaces, and its members

Two organization-scoped tables, `organizations` and `organization_members`,
the `require_organization_id()` function their policies compare against, and
a nullable `tenants.organization_id`. Every existing workspace gets an
organization of its own, named and slugged as the workspace is; its owners
become the organization's `org_admin`s and everyone else, admins included,
its `member`s. Admins keep administering the workspace through their
workspace role. Making them `org_admin` too would have let an admin demote
the owner within the organization, and then lock them out of it.

The row-level-security DDL is a verbatim copy of `switch_core/db/rls_ddl.py`
as it stood when this migration was written, copied rather than imported for
the reason `265ed188ad6f` gives.

Expand only: a process from before this revision never reads the new tables
or column. A workspace it creates meanwhile has no organization, which is
why the column is nullable; the revision that makes it `NOT NULL` gives those
workspaces one first.

Revision ID: 238c68b7306e
Revises: b7e1d4c9a2f6
Create Date: 2026-10-28 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "238c68b7306e"
down_revision: str | Sequence[str] | None = "b7e1d4c9a2f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_ORGANIZATION_FUNCTION_NAME = "require_organization_id"
ORGANIZATION_POLICY_NAME = "organization_isolation"
_SQLSTATE = "42501"

CREATE_REQUIRE_ORGANIZATION_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {REQUIRE_ORGANIZATION_FUNCTION_NAME}() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
    bound_tenant text := current_setting('app.tenant_id', true);
    bound_organization text := current_setting('app.organization_id', true);
    tenant_organization text;
BEGIN
    IF bound_tenant IS NOT NULL AND btrim(bound_tenant) <> '' THEN
        SELECT organization_id INTO tenant_organization
            FROM tenants WHERE id = bound_tenant;
        IF tenant_organization IS NULL THEN
            RAISE EXCEPTION 'the workspace bound to this session belongs to no organization'
                USING ERRCODE = '{_SQLSTATE}';
        END IF;
        IF bound_organization IS NOT NULL AND btrim(bound_organization) <> ''
                AND bound_organization <> tenant_organization THEN
            RAISE EXCEPTION 'app.organization_id is not the bound workspace''s organization'
                USING ERRCODE = '{_SQLSTATE}';
        END IF;
        RETURN tenant_organization;
    END IF;
    IF bound_organization IS NULL OR btrim(bound_organization) = '' THEN
        RAISE EXCEPTION 'neither app.organization_id nor app.tenant_id is set on this session'
            USING ERRCODE = '{_SQLSTATE}';
    END IF;
    RETURN bound_organization;
END;
$$
"""


def _create_policy(table: str, column: str) -> str:
    predicate = f'"{column}" = (SELECT {REQUIRE_ORGANIZATION_FUNCTION_NAME}())'
    return (
        f'CREATE POLICY {ORGANIZATION_POLICY_NAME} ON "{table}"\n'
        f"    FOR ALL\n"
        f"    USING ({predicate})\n"
        f"    WITH CHECK ({predicate})"
    )


def upgrade() -> None:
    op.execute(CREATE_REQUIRE_ORGANIZATION_FUNCTION)

    op.create_table(
        "organizations",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("workos_organization_id", sa.Text(), nullable=True),
        sa.Column("customer_id", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
        sa.UniqueConstraint("workos_organization_id"),
        sa.UniqueConstraint("customer_id"),
    )
    op.execute('ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy("organizations", "id"))

    op.create_table(
        "organization_members",
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("organization_id", "user_id"),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name="fk_organization_members_organization",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "role IN ('org_admin', 'member')", name="ck_organization_members_role"
        ),
    )
    op.execute('ALTER TABLE "organization_members" ENABLE ROW LEVEL SECURITY')
    op.execute(_create_policy("organization_members", "organization_id"))

    op.add_column("tenants", sa.Column("organization_id", sa.Text(), nullable=True))
    op.create_foreign_key(
        "fk_tenants_organization",
        "tenants",
        "organizations",
        ["organization_id"],
        ["id"],
    )
    # Read by user, and joined on the organization, on every authenticated
    # request (`tenants_bindable_by_user`).
    op.create_index(
        "ix_organization_members_user_id", "organization_members", ["user_id"]
    )
    op.create_index("ix_tenants_organization_id", "tenants", ["organization_id"])

    # One organization per workspace. Workspace slugs are unique, so the slug
    # carries each organization back to the workspace it was made for.
    op.execute(
        "INSERT INTO organizations (id, slug, name, created_at) "
        "SELECT gen_random_uuid()::text, slug, name, created_at FROM tenants"
    )
    op.execute(
        "UPDATE tenants SET organization_id = organizations.id "
        "FROM organizations WHERE organizations.slug = tenants.slug"
    )
    op.execute(
        "INSERT INTO organization_members (organization_id, user_id, role, created_at) "
        "SELECT tenants.organization_id, tenant_members.user_id, "
        "CASE WHEN tenant_members.role = 'owner' "
        "THEN 'org_admin' ELSE 'member' END, tenant_members.created_at "
        "FROM tenant_members JOIN tenants ON tenants.id = tenant_members.tenant_id"
    )


def downgrade() -> None:
    op.drop_index("ix_tenants_organization_id", table_name="tenants")
    op.drop_index("ix_organization_members_user_id", table_name="organization_members")
    op.drop_constraint("fk_tenants_organization", "tenants", type_="foreignkey")
    op.drop_column("tenants", "organization_id")
    op.execute(
        f'DROP POLICY IF EXISTS {ORGANIZATION_POLICY_NAME} ON "organization_members"'
    )
    op.drop_table("organization_members")
    op.execute(f'DROP POLICY IF EXISTS {ORGANIZATION_POLICY_NAME} ON "organizations"')
    op.drop_table("organizations")
    op.execute(f"DROP FUNCTION IF EXISTS {REQUIRE_ORGANIZATION_FUNCTION_NAME}()")
