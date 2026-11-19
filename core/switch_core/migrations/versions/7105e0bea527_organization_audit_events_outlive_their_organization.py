"""organization audit events outlive their organization: drop the foreign key

Deleting an organization deletes its `organizations` row, and the foreign key
from `organization_audit_events` would hold that back. The runtime role may
not delete audit events (`grant_runtime_role`), and the history is kept on
purpose, as `a3d9f6c2b871` keeps a deleted workspace's. So the key goes; the
`organization_isolation` policy on the table is unchanged
(`db/rls_ddl.py`, ORGANIZATION_HISTORY_TABLES).

Marked `expand_only`: dropping the key only relaxes the schema, and no
release relies on it. The downgrade puts the key back `NOT VALID`, so it does
not fail on the history of an organization deleted in between.

Revision ID: 7105e0bea527
Revises: e3b8d1f6a2c4
Create Date: 2026-11-12 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "7105e0bea527"
down_revision: str | Sequence[str] | None = "e3b8d1f6a2c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.drop_constraint(
        "fk_organization_audit_events_organization",
        "organization_audit_events",
        type_="foreignkey",
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE organization_audit_events ADD CONSTRAINT "
        "fk_organization_audit_events_organization FOREIGN KEY (organization_id) "
        "REFERENCES organizations (id) NOT VALID"
    )
