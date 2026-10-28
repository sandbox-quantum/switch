"""template installs: which template, at which revision, made an agent or room

``template_installs`` holds one row for each template run whose source the
server vouches for: an official template, or a saved one, by id, with the
revision it was at and the inputs it was rendered with.
``template_install_resources`` links each agent and room the run created to
it, under the key the template gives it, with a fingerprint of each value
the template set, so an update can tell a value nobody changed from one
somebody did.

Expand only: a release from before this revision never reads either table.

The row-level-security DDL is a verbatim copy of ``switch_core/db/rls_ddl.py``
as it stood when this migration was written, copied rather than imported for
the reason ``265ed188ad6f`` gives.

Revision ID: a4c1e7b93d20
Revises: f68b679599ab
Create Date: 2026-10-26 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "a4c1e7b93d20"
down_revision: str | None = "f68b679599ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

REQUIRE_TENANT_FUNCTION_NAME = "require_tenant_id"
POLICY_NAME = "tenant_isolation"

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
        "template_installs",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("template_id", sa.Text(), nullable=False),
        sa.Column("template_name", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("inputs", JSONB(), nullable=False),
        sa.Column("builtins", JSONB(), nullable=False),
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
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_template_installs_tenant"
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.CheckConstraint(
            "source IN ('official', 'saved')", name="ck_template_installs_source"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("id", "tenant_id", name="uq_template_installs_id_tenant"),
    )
    op.create_index(
        "ix_template_installs_tenant_template",
        "template_installs",
        ["tenant_id", "template_id"],
    )
    op.create_table(
        "template_install_resources",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("install_id", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("agent_id", sa.Text(), nullable=True),
        sa.Column("room_id", sa.Text(), nullable=True),
        sa.Column("fingerprints", JSONB(), nullable=False),
        sa.Column("notice", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_template_install_resources_tenant"
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "install_id"],
            ["template_installs.tenant_id", "template_installs.id"],
            name="fk_template_install_resources_install",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "agent_id"],
            ["agents.tenant_id", "agents.id"],
            name="fk_template_install_resources_agent",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id", "room_id"],
            ["rooms.tenant_id", "rooms.id"],
            name="fk_template_install_resources_room",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "(agent_id IS NULL) <> (room_id IS NULL)",
            name="ck_template_install_resources_one_resource",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_template_install_resources_agent",
        "template_install_resources",
        ["tenant_id", "agent_id"],
        unique=True,
        postgresql_where=sa.text("agent_id IS NOT NULL"),
    )
    op.create_index(
        "uq_template_install_resources_room",
        "template_install_resources",
        ["tenant_id", "room_id"],
        unique=True,
        postgresql_where=sa.text("room_id IS NOT NULL"),
    )
    op.create_index(
        "ix_template_install_resources_install",
        "template_install_resources",
        ["tenant_id", "install_id"],
    )
    for table in ("template_installs", "template_install_resources"):
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        op.execute(_create_policy(table))


def downgrade() -> None:
    for table in ("template_install_resources", "template_installs"):
        op.execute(f'DROP POLICY IF EXISTS {POLICY_NAME} ON "{table}"')
    op.drop_index(
        "ix_template_install_resources_install",
        table_name="template_install_resources",
    )
    op.drop_index(
        "uq_template_install_resources_room", table_name="template_install_resources"
    )
    op.drop_index(
        "uq_template_install_resources_agent", table_name="template_install_resources"
    )
    op.drop_table("template_install_resources")
    op.drop_index(
        "ix_template_installs_tenant_template", table_name="template_installs"
    )
    op.drop_table("template_installs")
