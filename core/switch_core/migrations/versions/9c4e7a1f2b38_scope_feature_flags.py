"""Scope feature flags to the workspace that set them.

Revision ID: 9c4e7a1f2b38
Revises: eb24eafa59a0
Create Date: 2026-10-07 00:00:00.000000

Every flag that was on server-wide is copied into every tenant, so it stays on
for each workspace in it. A row that was off is not copied: off was already the
default, and a copied row would be a workspace choice that hides any server
default set later.
A workspace created later takes the server-wide defaults instead, which come
from `FEATURE_FLAGS_DEFAULT_ON` rather than from this table. The flags that
were on are logged, so an operator knows what to put in that setting.
Downgrade cannot reverse that copy faithfully once workspaces disagree; it
keeps a flag on if any workspace had it on.
"""

import logging

import sqlalchemy as sa
from alembic import op

logger = logging.getLogger("alembic.runtime.migration")

revision = "9c4e7a1f2b38"
down_revision = "eb24eafa59a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("feature_flags", "feature_flags_global")
    op.execute(
        "ALTER TABLE feature_flags_global RENAME CONSTRAINT feature_flags_pkey TO feature_flags_global_pkey"
    )
    op.create_table(
        "feature_flags",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenants.id"], name="fk_feature_flags_tenant"
        ),
        sa.PrimaryKeyConstraint("tenant_id", "key", name="feature_flags_pkey"),
    )
    op.execute(
        "INSERT INTO feature_flags (tenant_id, key, enabled, updated_at) "
        "SELECT t.id, f.key, f.enabled, f.updated_at "
        "FROM tenants t CROSS JOIN feature_flags_global f WHERE f.enabled"
    )
    enabled = [
        row.key
        for row in op.get_bind().execute(
            sa.text("SELECT key FROM feature_flags_global WHERE enabled ORDER BY key")
        )
    ]
    if enabled:
        logger.warning(
            "Feature flags are now per workspace. These were on for the whole "
            "deployment and are now on in every existing workspace; add them to "
            "FEATURE_FLAGS_DEFAULT_ON to keep them on in workspaces created from "
            "now on: %s",
            ", ".join(enabled),
        )
    op.drop_table("feature_flags_global")
    op.execute('ALTER TABLE "feature_flags" ENABLE ROW LEVEL SECURITY')
    op.execute(
        'CREATE POLICY tenant_isolation ON "feature_flags"\n'
        "    FOR ALL\n"
        '    USING ("tenant_id" = (SELECT require_tenant_id()))\n'
        '    WITH CHECK ("tenant_id" = (SELECT require_tenant_id()))'
    )


def downgrade() -> None:
    op.create_table(
        "feature_flags_global",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("key", name="feature_flags_global_pkey"),
    )
    op.execute(
        "INSERT INTO feature_flags_global (key, enabled, updated_at) "
        "SELECT key, bool_or(enabled), max(updated_at) FROM feature_flags GROUP BY key"
    )
    op.drop_table("feature_flags")
    op.rename_table("feature_flags_global", "feature_flags")
    op.execute(
        "ALTER TABLE feature_flags RENAME CONSTRAINT feature_flags_global_pkey TO feature_flags_pkey"
    )
