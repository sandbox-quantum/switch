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
whichever one the lookup happened to see first. The pre-flight check below
refuses to proceed rather than guess if it ever finds two users sharing an
``oidc_sub`` value at all, not only the no-issuer case: two full pairs
sharing the same ``(iss, sub)`` would otherwise die on the new unique
constraint with a bare violation instead of a message naming which users are
involved, and a legacy row sharing a subject with a full-pair row would
migrate cleanly on *both* sides and then never resolve on the legacy side
again — later logins would always match the full pair first, silently
orphaning whichever account only the legacy row named. Either way that is a
data problem for a human to resolve by hand, not one this migration should
paper over by silently picking a side. The check also catches — and blocks —
the rare legitimate case of two different issuers happening to assign the
same subject string to two different users: telling that apart from a real
collision automatically isn't implemented, so a human has to look and
disambiguate it by hand either way.

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
            SELECT metadata->>'oidc_sub' AS sub,
                   count(*) AS n,
                   array_agg(metadata->>'oidc_iss') AS issuers
            FROM users
            WHERE metadata ? 'oidc_sub'
            GROUP BY metadata->>'oidc_sub'
            HAVING count(*) > 1
            """
        )
    ).fetchall()
    if duplicates:
        raise RuntimeError(
            "Refusing to migrate: more than one user's oidc_sub metadata "
            "names the same subject, and this migration cannot safely tell "
            "them apart — two users sharing an identical (iss, sub) pair "
            "would violate the unique constraint this migration adds, and a "
            "legacy (no-issuer) row sharing a subject with a full pair would "
            "migrate cleanly but then never be reachable again, since a "
            "later login always matches the full pair first: "
            + ", ".join(
                f"{row.sub!r}: issuers {[iss or '<no issuer>' for iss in row.issuers]}"
                for row in duplicates
            )
            + ". This includes the rare legitimate case of two different "
            "issuers happening to assign the same subject string to two "
            "different users — telling that apart from a real collision "
            "automatically isn't implemented, so it blocks here too. Resolve "
            "by hand: for a real collision, decide which account owns the "
            "subject and clear oidc_sub from users.metadata for the "
            "other(s); for a coincidence, disambiguate the values yourself "
            "(this migration will not do it for you) — then re-run."
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
