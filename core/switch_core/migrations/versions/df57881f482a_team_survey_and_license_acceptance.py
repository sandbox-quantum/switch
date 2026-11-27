"""users: team survey answers and license acceptance

Where the dashboard onboards people, each person answers "Tell us about your
team" once and accepts the license Switch is offered under. The answers and
when they were given, and the version of the license last accepted and when,
are kept on the person. Every existing row starts with neither.

Expand only: nullable columns, and checks every existing row and every row an
older release writes (leaving all four NULL) satisfies.

Revision ID: df57881f482a
Revises: a25845a0e7be
Create Date: 2026-11-26 13:14:30.448730

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "df57881f482a"
down_revision: str | None = "a25845a0e7be"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
expand_only: bool = True


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "team_survey", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )
    op.add_column(
        "users",
        sa.Column("team_survey_answered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users", sa.Column("license_accepted_version", sa.Text(), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column("license_accepted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        "ck_users_team_survey_complete",
        "users",
        "(team_survey IS NULL) = (team_survey_answered_at IS NULL)",
    )
    op.create_check_constraint(
        "ck_users_license_acceptance_complete",
        "users",
        "(license_accepted_version IS NULL) = (license_accepted_at IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_users_license_acceptance_complete", "users", type_="check")
    op.drop_constraint("ck_users_team_survey_complete", "users", type_="check")
    op.drop_column("users", "license_accepted_at")
    op.drop_column("users", "license_accepted_version")
    op.drop_column("users", "team_survey_answered_at")
    op.drop_column("users", "team_survey")
