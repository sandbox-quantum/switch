"""Claim token revocations across bounded network calls."""

import sqlalchemy as sa
from alembic import op

revision = "95fc38e451b6"
down_revision = "84eb27d340a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "github_issued_tokens",
        sa.Column("claim_until", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("github_issued_tokens", "claim_until")
