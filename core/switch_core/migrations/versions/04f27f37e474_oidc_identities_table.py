"""oidc identities become a table, not a metadata pair

Revision ID: 04f27f37e474
Revises: c8e4a10b7f36

Accounts are now keyed on verified email, not on login method (CHOO-2624): a
verified OIDC identity links to the account with a matching email instead of
being refused. A single ``oidc_iss``/``oidc_sub`` pair in ``users.metadata``
can only ever name one identity per user, which cannot represent that — a
password sign-up that later links a second IdP needs a second identity on the
same account. Identity moves into its own table instead: one row per linked
``(iss, sub)``, unique so a subject can never be bound to more than one
account, with a user able to hold several.

Existing ``oidc_iss``/``oidc_sub`` pairs are copied into the new table and
removed from ``metadata``, which becomes the single remaining source of truth
going forward. Rows that predate ``oidc_iss`` being stored (``oidc_sub`` only)
are copied too, with a NULL issuer — the application still resolves those by
subject alone and backfills the issuer on next login, exactly as it did
before this identity had its own table, so a flag-off deployment (whose IdP
never emits ``email_verified``, e.g. Okta's org authorization server for
directory users) keeps logging that account in rather than being newly locked
out or forked into a second account by a changed email.

``UNIQUE(iss, sub)`` does not constrain a NULL issuer at all — Postgres never
considers two NULLs equal — so a separate partial unique index enforces at
most one such row per subject; without it, two different users sharing a
legacy subject would both migrate cleanly and a login would then resolve to
whichever one the lookup happened to see first. Two users cannot share a
legacy subject in practice (each was some real person's login), so this
refuses to proceed rather than guess which one is right if it ever finds one:
that is a data problem for a human to resolve by hand, not one this migration
should paper over by silently picking a side.

The email column also gains a case-insensitive index: linking now matches an
existing account by email, and a compare that ignored case here would defeat
the very guarantee this migration exists to add.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "04f27f37e474"
down_revision: str | Sequence[str] | None = "c8e4a10b7f36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()

    duplicates = connection.execute(
        sa.text(
            """
            SELECT metadata->>'oidc_sub' AS sub, count(*) AS n
            FROM users
            WHERE metadata ? 'oidc_sub' AND NOT (metadata ? 'oidc_iss')
            GROUP BY metadata->>'oidc_sub'
            HAVING count(*) > 1
            """
        )
    ).fetchall()
    if duplicates:
        raise RuntimeError(
            "Refusing to migrate: more than one user shares the same legacy "
            "oidc_sub with no recorded issuer, which cannot be told apart by "
            "subject alone: "
            + ", ".join(f"{row.sub!r} ({row.n} users)" for row in duplicates)
            + ". Resolve by hand — decide which account actually owns each "
            "subject and clear oidc_sub from users.metadata for the "
            "other(s) — then re-run this migration."
        )

    op.create_table(
        "oidc_identities",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("iss", sa.Text(), nullable=True),
        sa.Column("sub", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("iss", "sub", name="uq_oidc_identities_iss_sub"),
    )
    op.create_index("ix_oidc_identities_sub", "oidc_identities", ["sub"])
    op.create_index(
        "ix_oidc_identities_sub_null_iss",
        "oidc_identities",
        ["sub"],
        unique=True,
        postgresql_where=sa.text("iss IS NULL"),
    )
    op.create_index("ix_users_email_lower", "users", [sa.text("lower(email)")])

    connection.execute(
        sa.text(
            """
            INSERT INTO oidc_identities (id, user_id, iss, sub)
            SELECT gen_random_uuid()::text, id, metadata->>'oidc_iss', metadata->>'oidc_sub'
            FROM users
            WHERE metadata ? 'oidc_sub'
            """
        )
    )
    connection.execute(
        sa.text(
            "UPDATE users SET metadata = metadata - 'oidc_iss' - 'oidc_sub' "
            "WHERE metadata ? 'oidc_sub'"
        )
    )


def downgrade() -> None:
    """Best effort, not a full inverse.

    A user linked to more than one identity — impossible under the old
    single-slot ``metadata`` pair this recreates — keeps only one of them.
    When an UPDATE ... FROM matches a target row against more than one source
    row, PostgreSQL applies exactly one of them and which one is unspecified
    — not a documented "last write wins" order, just whichever the query
    plan happens to produce. That loss is inherent to the old shape, not a
    defect in this statement: there is nowhere to put a second identity once
    ``oidc_identities`` is gone.
    """
    connection = op.get_bind()
    connection.execute(
        sa.text(
            """
            UPDATE users
            SET metadata = coalesce(metadata, '{}'::jsonb)
                || jsonb_build_object('oidc_sub', oidc_identities.sub)
            FROM oidc_identities
            WHERE oidc_identities.user_id = users.id
                AND oidc_identities.iss IS NULL
            """
        )
    )
    connection.execute(
        sa.text(
            """
            UPDATE users
            SET metadata = coalesce(metadata, '{}'::jsonb)
                || jsonb_build_object('oidc_iss', oidc_identities.iss, 'oidc_sub', oidc_identities.sub)
            FROM oidc_identities
            WHERE oidc_identities.user_id = users.id
                AND oidc_identities.iss IS NOT NULL
            """
        )
    )
    op.drop_index("ix_users_email_lower", table_name="users")
    op.drop_index("ix_oidc_identities_sub_null_iss", table_name="oidc_identities")
    op.drop_index("ix_oidc_identities_sub", table_name="oidc_identities")
    op.drop_table("oidc_identities")
