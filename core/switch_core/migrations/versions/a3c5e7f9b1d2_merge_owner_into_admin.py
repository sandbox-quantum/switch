"""merge the workspace owner role into admin

A workspace had two roles that ran it, `owner` and `admin`, alike in
everything but who could grant or remove ownership. They become one: every
`owner` membership and invitation is now `admin`, and the role checks accept
only `admin` and `member`. A workspace keeps at least one admin, as it kept
at least one owner.

Not expand only: a release from before this revision writes `owner` when a
workspace is created, which the narrowed check refuses.

Downgrading restores the checks that allow `owner`, but cannot tell which
admins were owners, so every admin stays an admin.

Revision ID: a3c5e7f9b1d2
Revises: f68b679599ab
Create Date: 2026-10-27 09:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "a3c5e7f9b1d2"
down_revision: str | None = "f68b679599ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CHECKS = (
    ("tenant_members", "ck_tenant_members_role"),
    ("invitations", "ck_invitations_role"),
)


def upgrade() -> None:
    for table, check in _CHECKS:
        op.drop_constraint(check, table, type_="check")
        op.execute(f"UPDATE {table} SET role = 'admin' WHERE role = 'owner'")
        op.create_check_constraint(check, table, "role IN ('admin', 'member')")


def downgrade() -> None:
    for table, check in _CHECKS:
        op.drop_constraint(check, table, type_="check")
        op.create_check_constraint(check, table, "role IN ('owner', 'admin', 'member')")
