"""index tenant_members by user

`tenant_members`' primary key is (tenant_id, user_id), which serves a lookup
by tenant but not by user alone. Resolving which workspaces a signed-in person
may enter (`tenants_of_user()`, on every authenticated gateway request) and
account deletion's pass over a person's workspaces both look up by user, and
without this index read the whole table.

Expand only: an index changes no process's reads or writes.

Revision ID: 95b5d17f4519
Revises: e5a9c3d71f08
Create Date: 2026-10-30 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "95b5d17f4519"
down_revision: str | None = "e5a9c3d71f08"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_index("ix_tenant_members_user_id", "tenant_members", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_tenant_members_user_id", table_name="tenant_members")
