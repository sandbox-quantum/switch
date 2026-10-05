"""claim connector_added for every connector that already exists

Revision ID: 2575637e78d4
Revises: e4a7c1d93b25

`connector_added` reports a connector's setup time — configuration saved to
first connect — once, on that first connect, guarded by a claim in
`telemetry_milestones`. The claim used to be taken only while telemetry was
on, so a connector that existed before telemetry started reporting claimed it
on its first connect afterwards and reported its whole age as setup time:
millions of seconds.

The claim is now taken whether telemetry is on or not. A connector that exists
at this migration has, as far as anything can tell, already made its first
connect unobserved, so its claim is taken here and it never reports
`connector_added`. One that never managed to connect is the exception it
costs: if it connects for the first time later, that goes unreported too.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "2575637e78d4"
down_revision: str | Sequence[str] | None = "e4a7c1d93b25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Runs as the schema owner, which row-level security does not restrict, so
    # every tenant's connectors are seen.
    op.execute(
        """
        INSERT INTO telemetry_milestones (name)
        SELECT 'connector_added:' || id FROM collaboration_bridges
        ON CONFLICT (name) DO NOTHING
        """
    )


def downgrade() -> None:
    # The claims taken here cannot be told apart from ones a real report took,
    # and keeping them only keeps those connectors quiet.
    pass
