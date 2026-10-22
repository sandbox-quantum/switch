"""audit events outlive their tenant: drop fk_audit_events_tenant

Deleting a workspace deletes its `tenants` row, and a foreign key from
`audit_events` would hold that back. The runtime role may not delete audit
events (`grant_runtime_role`), and the history is kept on purpose, as it is
kept after an account is deleted. So the key goes; the `tenant_isolation`
policy on the table is unchanged and still compares `tenant_id`
(`db/rls_ddl.py`, HISTORY_TABLES).

Marked `expand_only`: dropping the key only relaxes the schema, and no
release reads or relies on it, so an older pod keeps serving through a
rolling upgrade. The downgrade puts the key back `NOT VALID`, so it does not
fail on the history of a workspace deleted in between, and checks every new
row.

Revision ID: a3d9f6c2b871
Revises: c7715ebb95c9
Create Date: 2026-10-21 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "a3d9f6c2b871"
down_revision: str | Sequence[str] | None = "c7715ebb95c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.drop_constraint("fk_audit_events_tenant", "audit_events", type_="foreignkey")


def downgrade() -> None:
    op.execute(
        "ALTER TABLE audit_events ADD CONSTRAINT fk_audit_events_tenant "
        "FOREIGN KEY (tenant_id) REFERENCES tenants (id) NOT VALID"
    )
