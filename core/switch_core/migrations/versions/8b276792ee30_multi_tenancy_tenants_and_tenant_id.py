"""multi-tenancy phase 1: tenants, tenant_members, and tenant_id everywhere

Implements the schema half of Phase 1 multi-tenancy (see
`docs/old/multi-tenancy-phase1-db.md`): every table holding customer data
gains a non-null `tenant_id`, and every foreign key between two such tables
gains it too, so a row can no longer reference a parent in another tenant.

Order:

1. Create `tenants` and `tenant_members`.
2. Insert tenant zero — the one tenant that exists before this migration
   runs — with a fixed id written literally below rather than imported from
   `switch_core.db.models.TENANT_ZERO_ID`. A migration is a record of a
   change that already happened; importing the live constant would let a
   later edit to it silently change what this migration means, the same
   reason the notify trigger keeps a frozen copy of its DDL instead of
   importing `notify_ddl.py`.
3. Insert a `tenant_members` row for every existing user: `owner` where
   `users.role = 'admin'`, `member` otherwise.
4. Add `tenant_id` to every scoped table as `NOT NULL DEFAULT '<zero>'`, then
   drop the default. Since Postgres 11, adding a column with a constant
   default is a metadata-only change — no rewrite, no table lock beyond
   `ACCESS EXCLUSIVE` for the instant it takes to update the catalog. The
   alternative sequence (nullable, backfill every row, then `SET NOT NULL`)
   is what the spike proposed and is not needed here: there is only one
   tenant to backfill to, the same constant for every row, so a computed
   backfill buys nothing and would rewrite `messages` and `media_blobs`
   (20MB rows) under an exclusive lock instead.
5. Add the foreign key to `tenants`, and `UNIQUE (id, tenant_id)` on the
   tables actually referenced by a composite key.
6. Swap the uniqueness constraints that were global singletons and are not
   anymore: `agents.name`, `clients.matrix_user_id`, `rooms.matrix_room_id`,
   the `reference_types` primary key, and the `collaboration_bridges`
   default-bridge partial index.
7. Rewrite every scoped-to-scoped foreign key as composite: drop the old
   single-column constraint, add the new one `NOT VALID`, then `VALIDATE
   CONSTRAINT` — so the validation scan takes a lock no stronger than a
   plain read for the duration of the scan, rather than blocking writes for
   as long as the scan takes. Five keys use the Postgres 15+ column-list
   `ON DELETE SET NULL (<col>)` form: a plain multi-column `SET NULL` would
   null every referencing column including `tenant_id`, which then fails
   the new NOT NULL constraint on the very delete this is meant to allow.

This migration creates no roles, issues no grants, and adds no row-level
security policy — that is a separate, later change (see the design doc's
"runtime role" section).

Only tenant zero exists when this runs, so the usual expand-then-contract
caution does not apply yet: there is no second tenant's traffic to keep
running against the old shape while this lands. From the next customer
onward it does, and any future schema change here must be split into an
expand migration (deployed, then the application updated to use the new
shape) and a contract migration (deployed once nothing reads the old shape),
never both at once.

Revision ID: 8b276792ee30
Revises: b47e0c39a1f5
Create Date: 2026-09-09 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8b276792ee30"
down_revision: str | None = "b47e0c39a1f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The fixed id of the one tenant that exists before a second is ever
# onboarded. Matches `switch_core.db.models.TENANT_ZERO_ID`, copied rather
# than imported — see the module docstring.
TENANT_ZERO_ID = "00000000-0000-0000-0000-000000000000"

# Every table gaining `tenant_id`. Order doesn't matter for the column add
# (each statement stands alone), so this is alphabetical rather than
# dependency order.
SCOPED_TABLES = [
    "agent_runtime_states",
    "agent_sessions",
    "agent_skills",
    "agents",
    "api_keys",
    "bridge_message_map",
    "client_rooms",
    "clients",
    "collaboration_bridges",
    "delivery_cursors",
    "documents",
    "external_user_claims",
    "external_users",
    "media_blobs",
    "message_attachments",
    "messages",
    "models",
    "package_documents",
    "package_references",
    "packages",
    "reference_types",
    "references",
    "role_leases",
    "room_agents",
    "room_documents",
    "room_groups",
    "room_links",
    "room_packages",
    "room_references",
    "room_roles",
    "room_skills",
    "rooms",
    "server_connectors",
    "skills",
    "tasks",
    "tools",
]

# The 13 scoped tables referenced by a composite foreign key elsewhere, and so
# need `UNIQUE (id, tenant_id)` in addition to the plain FK to `tenants`.
# `reference_types` has no surrogate `id` at all (its natural key already
# becomes the composite primary key below) so it is not in this list even
# though it is scoped.
ID_TENANT_UNIQUE_TABLES = [
    "agents",
    "api_keys",
    "clients",
    "collaboration_bridges",
    "documents",
    "external_users",
    "messages",
    "packages",
    "references",
    "room_groups",
    "room_roles",
    "rooms",
    "skills",
]

# Every foreign key from a scoped table to another scoped table, rewritten to
# carry `tenant_id`. `ondelete` is the *new* (possibly column-list) clause;
# `downgrade` derives the original single-column clause from it.
#
# (table, old_constraint_name, local_column, ref_table, ref_column, new_constraint_name, ondelete)
FK_REWRITES: list[tuple[str, str, str, str, str, str, str | None]] = [
    (
        "client_rooms",
        "client_rooms_client_id_fkey",
        "client_id",
        "clients",
        "id",
        "fk_client_rooms_client",
        None,
    ),
    (
        "client_rooms",
        "client_rooms_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_client_rooms_room",
        None,
    ),
    (
        "agents",
        "agents_client_id_fkey",
        "client_id",
        "clients",
        "id",
        "fk_agents_client",
        None,
    ),
    (
        "agents",
        "fk_agents_api_key_id",
        "api_key_id",
        "api_keys",
        "id",
        "fk_agents_api_key",
        None,
    ),
    (
        "agents",
        "fk_agents_parent_agent_id",
        "parent_agent_id",
        "agents",
        "id",
        "fk_agents_parent_agent",
        "SET NULL (parent_agent_id)",
    ),
    (
        "tools",
        "tools_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_tools_agent",
        None,
    ),
    (
        "models",
        "models_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_models_agent",
        None,
    ),
    (
        "skills",
        "skills_owner_agent_id_fkey",
        "owner_agent_id",
        "agents",
        "id",
        "fk_skills_owner_agent",
        None,
    ),
    (
        "agent_skills",
        "agent_skills_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_agent_skills_agent",
        None,
    ),
    (
        "agent_skills",
        "agent_skills_skill_id_fkey",
        "skill_id",
        "skills",
        "id",
        "fk_agent_skills_skill",
        None,
    ),
    (
        "rooms",
        "rooms_bridge_id_fkey",
        "bridge_id",
        "collaboration_bridges",
        "id",
        "fk_rooms_bridge",
        None,
    ),
    (
        "rooms",
        "rooms_group_id_fkey",
        "group_id",
        "room_groups",
        "id",
        "fk_rooms_group",
        "SET NULL (group_id)",
    ),
    (
        "room_agents",
        "room_agents_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_agents_room",
        None,
    ),
    (
        "room_agents",
        "room_agents_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_room_agents_agent",
        None,
    ),
    (
        "room_skills",
        "room_skills_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_skills_room",
        None,
    ),
    (
        "room_skills",
        "room_skills_skill_id_fkey",
        "skill_id",
        "skills",
        "id",
        "fk_room_skills_skill",
        None,
    ),
    (
        "room_groups",
        "room_groups_parent_group_id_fkey",
        "parent_group_id",
        "room_groups",
        "id",
        "fk_room_groups_parent_group",
        "SET NULL (parent_group_id)",
    ),
    (
        "room_links",
        "room_links_source_room_id_fkey",
        "source_room_id",
        "rooms",
        "id",
        "fk_room_links_source_room",
        "CASCADE",
    ),
    (
        "room_links",
        "room_links_target_room_id_fkey",
        "target_room_id",
        "rooms",
        "id",
        "fk_room_links_target_room",
        "CASCADE",
    ),
    (
        "room_roles",
        "room_roles_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_roles_room",
        "CASCADE",
    ),
    (
        "role_leases",
        "role_leases_role_id_fkey",
        "role_id",
        "room_roles",
        "id",
        "fk_role_leases_role",
        "CASCADE",
    ),
    (
        "role_leases",
        "role_leases_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_role_leases_room",
        "CASCADE",
    ),
    (
        "role_leases",
        "role_leases_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_role_leases_agent",
        "CASCADE",
    ),
    ("tasks", "tasks_room_id_fkey", "room_id", "rooms", "id", "fk_tasks_room", None),
    (
        "tasks",
        "tasks_requester_agent_id_fkey",
        "requester_agent_id",
        "agents",
        "id",
        "fk_tasks_requester_agent",
        "CASCADE",
    ),
    (
        "tasks",
        "tasks_performer_agent_id_fkey",
        "performer_agent_id",
        "agents",
        "id",
        "fk_tasks_performer_agent",
        "CASCADE",
    ),
    (
        "documents",
        "documents_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_documents_room",
        "CASCADE",
    ),
    (
        "documents",
        "documents_created_by_agent_id_fkey",
        "created_by_agent_id",
        "agents",
        "id",
        "fk_documents_created_by_agent",
        "SET NULL (created_by_agent_id)",
    ),
    (
        "room_references",
        "room_references_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_references_room",
        None,
    ),
    (
        "room_references",
        "room_references_reference_id_fkey",
        "reference_id",
        "references",
        "id",
        "fk_room_references_reference",
        None,
    ),
    (
        "room_documents",
        "room_documents_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_documents_room",
        None,
    ),
    (
        "room_documents",
        "room_documents_document_id_fkey",
        "document_id",
        "documents",
        "id",
        "fk_room_documents_document",
        None,
    ),
    (
        "room_packages",
        "room_packages_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_room_packages_room",
        None,
    ),
    (
        "room_packages",
        "room_packages_package_id_fkey",
        "package_id",
        "packages",
        "id",
        "fk_room_packages_package",
        None,
    ),
    (
        "package_references",
        "package_references_package_id_fkey",
        "package_id",
        "packages",
        "id",
        "fk_package_references_package",
        None,
    ),
    (
        "package_references",
        "package_references_reference_id_fkey",
        "reference_id",
        "references",
        "id",
        "fk_package_references_reference",
        None,
    ),
    (
        "package_documents",
        "package_documents_package_id_fkey",
        "package_id",
        "packages",
        "id",
        "fk_package_documents_package",
        None,
    ),
    (
        "package_documents",
        "package_documents_document_id_fkey",
        "document_id",
        "documents",
        "id",
        "fk_package_documents_document",
        None,
    ),
    (
        "collaboration_bridges",
        "collaboration_bridges_client_id_fkey",
        "client_id",
        "clients",
        "id",
        "fk_collaboration_bridges_client",
        None,
    ),
    (
        "server_connectors",
        "server_connectors_api_key_id_fkey",
        "api_key_id",
        "api_keys",
        "id",
        "fk_server_connectors_api_key",
        None,
    ),
    (
        "external_users",
        "external_users_bridge_id_fkey",
        "bridge_id",
        "collaboration_bridges",
        "id",
        "fk_external_users_bridge",
        None,
    ),
    (
        "external_users",
        "external_users_client_id_fkey",
        "client_id",
        "clients",
        "id",
        "fk_external_users_client",
        None,
    ),
    (
        "external_user_claims",
        "external_user_claims_external_user_id_fkey",
        "external_user_id",
        "external_users",
        "id",
        "fk_external_user_claims_external_user",
        "CASCADE",
    ),
    (
        "agent_sessions",
        "agent_sessions_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_agent_sessions_agent",
        "CASCADE",
    ),
    (
        "agent_sessions",
        "agent_sessions_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_agent_sessions_room",
        "CASCADE",
    ),
    (
        "agent_runtime_states",
        "agent_runtime_states_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_agent_runtime_states_agent",
        "CASCADE",
    ),
    (
        "agent_runtime_states",
        "agent_runtime_states_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_agent_runtime_states_room",
        "CASCADE",
    ),
    (
        "bridge_message_map",
        "bridge_message_map_bridge_id_fkey",
        "bridge_id",
        "collaboration_bridges",
        "id",
        "fk_bridge_message_map_bridge",
        "CASCADE",
    ),
    (
        "messages",
        "messages_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_messages_room",
        "CASCADE",
    ),
    (
        "messages",
        "messages_sender_client_id_fkey",
        "sender_client_id",
        "clients",
        "id",
        "fk_messages_sender_client",
        "SET NULL (sender_client_id)",
    ),
    (
        "message_attachments",
        "message_attachments_message_id_fkey",
        "message_id",
        "messages",
        "id",
        "fk_message_attachments_message",
        "CASCADE",
    ),
    (
        "delivery_cursors",
        "delivery_cursors_agent_id_fkey",
        "agent_id",
        "agents",
        "id",
        "fk_delivery_cursors_agent",
        "CASCADE",
    ),
    (
        "delivery_cursors",
        "delivery_cursors_room_id_fkey",
        "room_id",
        "rooms",
        "id",
        "fk_delivery_cursors_room",
        "CASCADE",
    ),
]


def _single_column_ondelete(ondelete: str | None) -> str | None:
    """Strip a column-list `SET NULL (col)` back to plain `SET NULL`."""
    if ondelete is None:
        return None
    return ondelete.split(" (")[0]


def upgrade() -> None:
    # 1. New tables.
    op.create_table(
        "tenants",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("slug", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_table(
        "tenant_members",
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('owner', 'admin', 'member')", name="ck_tenant_members_role"
        ),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("tenant_id", "user_id"),
    )

    # 2. Tenant zero.
    op.execute(
        f"""
        INSERT INTO tenants (id, slug, name)
        VALUES ('{TENANT_ZERO_ID}', 'default', 'Default')
        """
    )

    # 3. A membership row for every existing user.
    op.execute(
        f"""
        INSERT INTO tenant_members (tenant_id, user_id, role)
        SELECT '{TENANT_ZERO_ID}', id, CASE WHEN role = 'admin' THEN 'owner' ELSE 'member' END
        FROM users
        """
    )

    # 4. `tenant_id` on every scoped table, metadata-only (default then drop
    # the default, never backfill-then-set-not-null — see the docstring).
    for table in SCOPED_TABLES:
        op.add_column(
            table,
            sa.Column(
                "tenant_id",
                sa.Text(),
                nullable=False,
                server_default=TENANT_ZERO_ID,
            ),
        )
        op.alter_column(table, "tenant_id", server_default=None)

    # 5. FK to tenants, and UNIQUE (id, tenant_id) where referenced.
    for table in SCOPED_TABLES:
        op.create_foreign_key(
            f"fk_{table}_tenant", table, "tenants", ["tenant_id"], ["id"]
        )
    for table in ID_TENANT_UNIQUE_TABLES:
        op.create_unique_constraint(f"uq_{table}_id_tenant", table, ["id", "tenant_id"])

    # 6. Uniqueness swaps.
    op.drop_constraint("agents_name_key", "agents", type_="unique")
    op.create_unique_constraint(
        "uq_agents_tenant_name", "agents", ["tenant_id", "name"]
    )

    op.drop_constraint("clients_matrix_user_id_key", "clients", type_="unique")
    op.create_unique_constraint(
        "uq_clients_tenant_matrix_user_id", "clients", ["tenant_id", "matrix_user_id"]
    )

    op.drop_constraint("rooms_matrix_room_id_key", "rooms", type_="unique")
    op.create_unique_constraint(
        "uq_rooms_tenant_matrix_room_id", "rooms", ["tenant_id", "matrix_room_id"]
    )

    op.drop_constraint("reference_types_pkey", "reference_types", type_="primary")
    op.create_primary_key(
        "reference_types_pkey", "reference_types", ["tenant_id", "type"]
    )

    op.drop_index(
        "ix_collaboration_bridges_single_default", table_name="collaboration_bridges"
    )
    op.create_index(
        "ix_collaboration_bridges_single_default",
        "collaboration_bridges",
        ["tenant_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )

    # 7. Rewrite every scoped-to-scoped FK as composite.
    for (
        table,
        old_name,
        local_col,
        ref_table,
        ref_col,
        new_name,
        ondelete,
    ) in FK_REWRITES:
        op.drop_constraint(old_name, table, type_="foreignkey")
        op.create_foreign_key(
            new_name,
            table,
            ref_table,
            ["tenant_id", local_col],
            ["tenant_id", ref_col],
            ondelete=ondelete,
            postgresql_not_valid=True,
        )
        op.execute(f'ALTER TABLE "{table}" VALIDATE CONSTRAINT {new_name}')


def downgrade() -> None:
    # 7. Restore single-column FKs.
    for table, old_name, local_col, ref_table, ref_col, new_name, ondelete in reversed(
        FK_REWRITES
    ):
        op.drop_constraint(new_name, table, type_="foreignkey")
        op.create_foreign_key(
            old_name,
            table,
            ref_table,
            [local_col],
            [ref_col],
            ondelete=_single_column_ondelete(ondelete),
        )

    # 6. Restore original uniqueness.
    op.drop_index(
        "ix_collaboration_bridges_single_default", table_name="collaboration_bridges"
    )
    op.create_index(
        "ix_collaboration_bridges_single_default",
        "collaboration_bridges",
        ["is_default"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )

    op.drop_constraint("reference_types_pkey", "reference_types", type_="primary")
    op.create_primary_key("reference_types_pkey", "reference_types", ["type"])

    op.drop_constraint("uq_rooms_tenant_matrix_room_id", "rooms", type_="unique")
    op.create_unique_constraint("rooms_matrix_room_id_key", "rooms", ["matrix_room_id"])

    op.drop_constraint("uq_clients_tenant_matrix_user_id", "clients", type_="unique")
    op.create_unique_constraint(
        "clients_matrix_user_id_key", "clients", ["matrix_user_id"]
    )

    op.drop_constraint("uq_agents_tenant_name", "agents", type_="unique")
    op.create_unique_constraint("agents_name_key", "agents", ["name"])

    # 5. Drop UNIQUE (id, tenant_id) and the FK to tenants.
    for table in ID_TENANT_UNIQUE_TABLES:
        op.drop_constraint(f"uq_{table}_id_tenant", table, type_="unique")
    for table in SCOPED_TABLES:
        op.drop_constraint(f"fk_{table}_tenant", table, type_="foreignkey")

    # 4. Drop tenant_id from every scoped table.
    for table in SCOPED_TABLES:
        op.drop_column(table, "tenant_id")

    # 1. Drop the new tables.
    op.drop_table("tenant_members")
    op.drop_table("tenants")
