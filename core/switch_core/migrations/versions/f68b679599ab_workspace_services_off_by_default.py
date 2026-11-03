"""workspace services off by default, and an index for withdrawn tokens

`tenants.services_on_by_default` says whether a catalog service no workspace
admin has switched on or off (`workspace_service_settings`) is on in the
workspace. A workspace made from now on starts with every service off, the
column's default, until an admin switches each on.

A workspace that already has members keeps every service on by default, as
it had: this revision sets the column for them, so nothing they connected or
granted stops working on upgrade, and every switch an admin already set is
kept as it is. A workspace with no members yet, as the one the first
migration makes on a fresh install, could not have used a service, so it
starts off like a new one.

`ix_service_token_issuances_unrevocable` serves marking the tokens no vendor
can revoke alone (`encrypted_token IS NULL`) that are still live when their
access is withdrawn, by `expires_at`.

Expand only: a release from before this revision never reads the column,
reads every service with no row as on, as it always did, and never uses the
index.

Revision ID: f68b679599ab
Revises: c7715ebb95c9
Create Date: 2026-10-23 08:25:37.727969

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f68b679599ab"
down_revision: str | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True

_INDEX = "ix_service_token_issuances_unrevocable"


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "services_on_by_default",
            sa.Boolean(),
            server_default="false",
            nullable=False,
        ),
    )
    op.execute(
        """
        UPDATE tenants SET services_on_by_default = true
        WHERE EXISTS (
            SELECT 1 FROM tenant_members WHERE tenant_members.tenant_id = tenants.id
        )
        """
    )
    op.create_index(
        _INDEX,
        "service_token_issuances",
        ["tenant_id", "expires_at"],
        postgresql_where=sa.text("encrypted_token IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX, table_name="service_token_issuances")
    op.drop_column("tenants", "services_on_by_default")
