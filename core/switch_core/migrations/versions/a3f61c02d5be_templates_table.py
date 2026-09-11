"""templates are held on the server, not passed around as files

Revision ID: a3f61c02d5be
Revises: b1d7c4f0a92e

A template has until now been a YAML file someone mailed you. This table is
where a Switch server keeps one, so a template can be uploaded once and found
by everyone on the server afterwards (CHOO-2677).

Two choices here are deliberate and worth stating, because they are what let
the format keep moving without this table moving with it.

``content`` is ``Text`` and holds the document exactly as it was uploaded. The
registry never parses, validates or normalises it. That is what makes the
round-trip byte-identical, and it means a document written for a newer format
than this server understands is still stored and served back intact rather
than rejected at the door.

``kind`` is free text rather than an enum or a check constraint. Room, group
and agent templates are all coming, and they should differ by a string, not by
a migration. An enum here would buy nothing and cost a schema change per kind.

Uniqueness is ``(owner_id, name)``, not ``name``: two people may each keep a
template called "deploy-room", but neither may keep two of their own by that
name. It is deliberately not widened to include the tenant — an owner belongs
to exactly one, so scoping the name to the owner already scopes it to the
tenant.

The table is tenant-scoped like every other table holding customer data, so it
carries ``tenant_id`` and arrives with row-level security already on it rather
than waiting to be swept up later. The DDL below is a verbatim copy of
``switch_core/db/rls_ddl.py`` as it stood when this migration was written,
copied rather than imported for the reason ``265ed188ad6f`` gives: a migration
records a change that already happened, and importing the live module would
let a later edit to it silently change what this migration means.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3f61c02d5be"
down_revision: str | Sequence[str] | None = "b1d7c4f0a92e"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

_PREDICATE = f'"tenant_id" = (SELECT {REQUIRE_TENANT_FUNCTION_NAME}())'
_CREATE_POLICY = (
    f'CREATE POLICY {POLICY_NAME} ON "templates"\n'
    f"    FOR ALL\n"
    f"    USING ({_PREDICATE})\n"
    f"    WITH CHECK ({_PREDICATE})"
)


def upgrade() -> None:
    op.create_table(
        "templates",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_templates_tenant"
        ),
        sa.UniqueConstraint("owner_id", "name", name="uq_templates_owner_name"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_templates_id_tenant"),
    )
    op.execute('ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY')
    op.execute(_CREATE_POLICY)


def downgrade() -> None:
    op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "templates"')
    op.drop_table("templates")
