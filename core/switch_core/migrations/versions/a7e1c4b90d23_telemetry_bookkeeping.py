"""telemetry bookkeeping: deployment identity, milestones, snapshot watermark

Three server-global tables, none tenant-scoped and none carrying row-level
security: each records a fact about the *installation*, which is the thing
above tenants rather than one of them.

`deployment_identity` is seeded here rather than at first use, and that is the
load-bearing part of this migration. Whether a deployment is new decides
whether it ever reports time-to-value, and the only moment that question can
be answered honestly is before the server has written anything of its own.
`installed_at` is set only when the database is genuinely empty of product
content; an existing deployment gets an identity with a null install date and
reports no milestones at all, rather than a date inferred from its oldest row.
A guess there would be wrong by an unknown margin in an unknown direction, and
every activation figure derived from it would look confident and be false.

Revision ID: a7e1c4b90d23
Revises: 5daaea6b674d
Create Date: 2026-09-16 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7e1c4b90d23"
down_revision: str | None = "5daaea6b674d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "deployment_identity",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("installed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_deployment_identity_singleton"),
    )

    op.create_table(
        "telemetry_milestones",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column(
            "emitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    op.create_table(
        "telemetry_snapshot_watermark",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_telemetry_snapshot_watermark_singleton"),
    )

    # The identity row, with the new-versus-existing decision made now.
    #
    # "Existing" is judged on product content — rooms, agents, messages — not
    # on rows the server seeds for itself at boot. A fresh deployment already
    # has a tenant, an admin user and a bootstrap key by the time anything
    # else runs, so testing for *any* row would classify every new install as
    # pre-existing and switch off the activation funnel everywhere.
    op.execute(
        """
        INSERT INTO deployment_identity (id, client_id, installed_at)
        SELECT
            1,
            gen_random_uuid()::text,
            CASE
                WHEN EXISTS (SELECT 1 FROM rooms)
                  OR EXISTS (SELECT 1 FROM agents)
                  OR EXISTS (SELECT 1 FROM messages)
                THEN NULL
                ELSE now()
            END
        """
    )


def downgrade() -> None:
    op.drop_table("telemetry_snapshot_watermark")
    op.drop_table("telemetry_milestones")
    op.drop_table("deployment_identity")
