"""grant revision never repeats: the ``service_grant_revision`` sequence

An agent host keeps a token while the revision it reads for the grant is
the one the token was issued under. A grant removed and made again started
at revision 1 again, so the host kept the token issued under the removed
grant. Every grant revision now comes from one sequence, which starts above
every revision the old count from 1 gave. Existing rows keep their
revisions until their next change.

Expand only: a process from before this revision writes `revision + 1` on an
update and the column's default on an insert, which works on this schema.
During the rollout of this migration, an older process writes `revision + 1`,
which a later `nextval` can give again to the same grant. The host then keeps
a token for up to `useUntil`, as before this change.

Revision ID: c5d1e8f3a6b2
Revises: b7e2c4a9d1f6
Create Date: 2026-11-12 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "c5d1e8f3a6b2"
down_revision: str | None = "b7e2c4a9d1f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.execute(
        "CREATE SEQUENCE service_grant_revision AS integer"
        " START WITH 1073741824"
        " MINVALUE 1073741824"
        " MAXVALUE 2147483647"
        " NO CYCLE"
    )
    op.execute(
        "ALTER TABLE service_grants ALTER COLUMN revision"
        " SET DEFAULT nextval('service_grant_revision')"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE service_grants ALTER COLUMN revision SET DEFAULT 1")
    op.execute("DROP SEQUENCE IF EXISTS service_grant_revision")
