"""schema_expand_only_revisions, and the keys each process can read

During a rolling deploy two releases serve one database. Once the newer one
has migrated, the older one found a schema head it did not know and refused
to start, so a restarted old pod crash-looped until the roll finished, and a
rollback across a migration could not start at all. A revision marked
`expand_only` (it only adds: new tables, nullable columns, indexes) is now
recorded here as it is applied, with the revision it follows, and an older
release accepts a head it reaches back from through those rows alone.

`switch_core_processes.key_ids` holds the ids of the keys in each process's
`SECRET_KEYS`, so a process starting with a new front key can see whether
every live process could read what it is about to write.

Expand only, and the first revision recorded as such, ahead of the others: `migrations/env.py`
records it once this revision has created the table.

Revision ID: e2b0df5be5ff
Revises: e5b2c8d1f7a3
Create Date: 2026-10-14 15:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "e2b0df5be5ff"
down_revision: str | None = "e5b2c8d1f7a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.create_table(
        "schema_expand_only_revisions",
        sa.Column("revision", sa.Text(), nullable=False),
        sa.Column("down_revision", sa.Text(), nullable=False),
        sa.Column(
            "applied_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("revision"),
    )
    op.add_column(
        "switch_core_processes",
        sa.Column("key_ids", ARRAY(sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("switch_core_processes", "key_ids")
    op.drop_table("schema_expand_only_revisions")
