"""Reserve distinct event sequence ranges for server boots."""

import sqlalchemy as sa
from alembic import op

revision = "51bc94a017d2"
down_revision = "48ab0298a34b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    sa.Sequence("agent_event_boot", maxvalue=2097150, cycle=False).create(op.get_bind())


def downgrade() -> None:
    sa.Sequence("agent_event_boot").drop(op.get_bind())
